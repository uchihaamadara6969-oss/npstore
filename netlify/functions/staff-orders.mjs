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
             delivered/cancelled by default; ?all=1 includes them —
             this is what the app's Order History view uses), newest
             first.
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

   NOTE: Accept (POST /api/staff-orders/accept) now lives in its own
   file, staff-orders-accept.mjs — it used to live here behind a
   manual pathname check, which turned out to be the real cause of a
   "not found" error on every accept attempt. Split out for a single,
   unambiguous path per function, matching every other function in
   this codebase.
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
  path: "/api/staff-orders",
  method: ["GET", "PATCH"]
};
