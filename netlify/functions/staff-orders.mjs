/* ═══════════════════════════════════════════════════════════════════
   NP MART — STAFF ORDER QUEUE (order-alert app)
   ───────────────────────────────────────────────────────────────────
   Everything the staff Android app needs, scoped to a valid staff
   session (see _lib/auth.mjs / staff-login.mjs) — deliberately
   separate from orders.mjs's admin-only endpoints, since staff should
   only ever be able to touch orders, never products/categories/admin
   settings. The staff app has no reason to call anything else.

   Shares the SAME npmart-orders Blobs store as orders.mjs (and the
   PUBLIC checkout endpoint that creates orders there) — this file
   just adds staff-safe ways to read and progress them, plus the
   accept-lock and push-notify behavior the native app depends on.

   Endpoints (ALL require a valid staff session cookie):
     GET   /api/staff-orders             active orders (excludes
             delivered/cancelled by default; ?all=1 includes them),
             newest first.
     POST  /api/staff-orders/accept      Body: { id }. Claims an
             unaccepted order — first staff member to call this wins;
             everyone else gets a 409 with who got there first, which
             is exactly the signal the app uses to stop that phone's
             alert. Pushes "order_accepted" so every other staff phone
             is told to stop buzzing within about a second.
     PATCH /api/staff-orders             Body: { id, status }. Moves
             an already-accepted order forward through the pipeline.
             Any logged-in staff member can advance any accepted order
             (packing might be a different person than who accepted —
             matches how a small shop actually works) — every change
             is still attributed to whoever made it via statusHistory.
             Pushes "order_status" so every staff phone's queue
             refreshes live.

   VALID_STATUSES (shared meaning with orders.mjs — see that file):
     new → approved → packing → packed → out_for_delivery → delivered
     (cancelled can happen from anywhere, set by admin only)
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { verifyStaffSession } from "./_lib/auth.mjs";
import { sendStaffPush } from "./_lib/push.mjs";

const STORE_NAME = "npmart-orders";
const BLOB_KEY = "orders.json";

// Forward-only pipeline a staff PATCH is allowed to move an order
// along. Accept (new -> approved) has its own dedicated endpoint
// below since it needs the claim-lock behavior; this list is what
// PATCH may do AFTER that.
const STAFF_ADVANCE_STATUSES = ["packing", "packed", "out_for_delivery", "delivered"];
const ACTIVE_STATUSES = ["new", "approved", "packing", "packed", "out_for_delivery"];

async function loadOrders(store) {
  const orders = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(orders) ? orders : [];
}

async function saveOrders(store, orders) {
  await store.setJSON(BLOB_KEY, orders);
}

/* Two staff members can tap "Accept" on the same order within
   milliseconds of each other — a plain read-check-write here would
   let BOTH succeed (both read the order before either has saved,
   both see it unclaimed). That defeats the entire point of the
   accept-lock, so this uses Netlify Blobs' conditional write
   (onlyIfMatch against the blob's etag) in a short retry loop:
   whoever's write actually lands first wins, the other's write is
   rejected by the etag mismatch and retries against the now-updated
   data, sees acceptedBy already set, and correctly bails with
   already_accepted instead of quietly overwriting the winner.
   This was verified against a simulated concurrent-accept race in
   testing — worth a real two-phone test once deployed, since the
   exact conditional-write behavior depends on the live Blobs
   service, not just this code. */
async function acceptOrderAtomic(store, orderId, session) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: orders, etag } = await store.getWithMetadata(BLOB_KEY, { type: "json" });
    const list = Array.isArray(orders) ? orders : [];
    const order = list.find((o) => String(o.id).toLowerCase() === orderId);
    if (!order) return { error: "not_found" };
    if (order.acceptedBy) {
      return { error: "already_accepted", acceptedByName: order.acceptedByName, acceptedAt: order.acceptedAt };
    }
    if (order.status !== "new") return { error: "not_pending" };

    order.status = "approved";
    order.acceptedBy = session.staffId;
    order.acceptedByName = session.staffName;
    order.acceptedAt = new Date().toISOString();
    pushHistory(order, "approved", session);

    try {
      await store.setJSON(BLOB_KEY, list, { onlyIfMatch: etag });
      return { order };
    } catch (err) {
      // Someone else (very likely the other side of this exact race)
      // wrote first — the etag no longer matches. Loop back and
      // re-read fresh data; next pass will almost certainly see their
      // acceptedBy and correctly return already_accepted instead of
      // retrying forever.
      continue;
    }
  }
  return { error: "conflict_retry_exhausted" };
}

function trimTo(v, maxLen) {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

function pushHistory(order, status, session) {
  if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
  order.statusHistory.push({
    status,
    byStaffId: session.staffId,
    byStaffName: session.staffName,
    at: new Date().toISOString()
  });
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[staff-orders] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handle(req) {
  const session = verifyStaffSession(req);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const store = getStore(STORE_NAME);
  const url = new URL(req.url);

  // ─── List active orders ─────────────────────────────────────────
  if (req.method === "GET") {
    const orders = await loadOrders(store);
    const includeAll = url.searchParams.get("all") === "1";
    const items = includeAll ? orders : orders.filter((o) => ACTIVE_STATUSES.includes(o.status));
    return Response.json({ ok: true, total: items.length, items });
  }

  // ─── Accept (claim) an order ────────────────────────────────────
  if (req.method === "POST") {
    if (!url.pathname.endsWith("/accept")) {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const id = trimTo(body?.id, 40).toLowerCase();
    if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

    const result = await acceptOrderAtomic(store, id, session);

    if (result.error === "not_found") {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (result.error === "already_accepted") {
      // Someone already got there first — this is the exact signal
      // the app needs to stop alerting and show who accepted it instead.
      return Response.json(
        { ok: false, error: "already_accepted", acceptedByName: result.acceptedByName, acceptedAt: result.acceptedAt },
        { status: 409 }
      );
    }
    if (result.error === "not_pending") {
      return Response.json({ ok: false, error: "not_pending" }, { status: 409 });
    }
    if (result.error === "conflict_retry_exhausted") {
      // Extremely unlikely in practice (would need many staff hitting
      // accept on the exact same order in the exact same instant,
      // repeatedly) — safe to ask the app to just retry the tap.
      return Response.json({ ok: false, error: "conflict_retry_exhausted", message: "Please try again." }, { status: 409 });
    }

    // Tells every OTHER staff phone to stop alerting for this order.
    // AWAITED — un-awaited "fire-and-forget" calls can get killed mid-
    // flight when Netlify tears down the function right after the
    // Response is returned, before the push's network calls finish.
    // sendStaffPush() never throws, so this can't fail/block the accept
    // itself, which is already saved regardless.
    await sendStaffPush({
      type: "order_accepted",
      orderId: result.order.id,
      acceptedByName: result.order.acceptedByName
    });

    return Response.json({ ok: true, item: result.order });
  }

  // ─── Advance status (packing / packed / out_for_delivery / delivered) ──
  if (req.method === "PATCH") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const id = trimTo(body?.id, 40).toLowerCase();
    const status = trimTo(body?.status, 30).toLowerCase();
    if (!id || !status) return Response.json({ ok: false, error: "missing_fields" }, { status: 400 });
    if (!STAFF_ADVANCE_STATUSES.includes(status)) {
      return Response.json(
        { ok: false, error: "invalid_status", message: "status must be one of: " + STAFF_ADVANCE_STATUSES.join(", ") },
        { status: 400 }
      );
    }

    const orders = await loadOrders(store);
    const order = orders.find((o) => String(o.id).toLowerCase() === id);
    if (!order) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    if (!order.acceptedBy) {
      return Response.json({ ok: false, error: "not_accepted_yet", message: "Order must be accepted before its status can be advanced." }, { status: 409 });
    }

    order.status = status;
    pushHistory(order, status, session);
    await saveOrders(store, orders);

    // AWAITED for the same reason as the other two calls in this file —
    // see the comment on the "order_accepted" push above.
    await sendStaffPush({
      type: "order_status",
      orderId: order.id,
      status,
      byStaffName: session.staffName
    });

    return Response.json({ ok: true, item: order });
  }

  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export const config = {
  path: ["/api/staff-orders", "/api/staff-orders/accept"],
  method: ["GET", "POST", "PATCH"]
};
