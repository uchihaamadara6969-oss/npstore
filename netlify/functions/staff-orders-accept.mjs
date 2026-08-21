/* ═══════════════════════════════════════════════════════════════════
   NP MART — ACCEPT (CLAIM) AN ORDER — staff order-alert app
   ───────────────────────────────────────────────────────────────────
   Split out into its own file/path (matching the one-file-one-path
   pattern every other function in this codebase uses — admin-login,
   admin-logout, admin-me, staff-login, staff-logout, staff-me are all
   separate files) instead of living inside staff-orders.mjs behind a
   manual "does the URL end in /accept" pathname check. That check was
   the actual bug behind the "not found" error on accept: it's not
   guaranteed that req.url reflects the literal matched path when a
   single function declares multiple config.path entries, so it's an
   unnecessary fragile way to route two different actions through one
   function. Giving accept its own real, single, unambiguous path
   removes that guesswork entirely.

   POST /api/staff-orders/accept   Body: { id }
     Requires a valid staff session cookie. Claims an unaccepted order
     — first staff member to call this wins; everyone else gets a 409
     with who got there first, which is exactly the signal the app
     uses to stop that phone's alert. Pushes "order_accepted" so every
     other staff phone is told to stop buzzing within about a second.
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { verifyStaffSession } from "./_lib/auth.mjs";
import { sendStaffPush } from "./_lib/push.mjs";

const STORE_NAME = "npmart-orders";
const BLOB_KEY = "orders.json";

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

/* Same conditional-write accept-lock as before — see staff-orders.mjs
   for the full explanation of why this needs to be atomic (two staff
   members tapping Accept within milliseconds of each other). */
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
      continue;
    }
  }
  return { error: "conflict_retry_exhausted" };
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[staff-orders-accept] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handle(req) {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const session = verifyStaffSession(req);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const id = trimTo(body?.id, 40).toLowerCase();
  if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

  const store = getStore(STORE_NAME);
  const result = await acceptOrderAtomic(store, id, session);

  if (result.error === "not_found") {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (result.error === "already_accepted") {
    return Response.json(
      { ok: false, error: "already_accepted", acceptedByName: result.acceptedByName, acceptedAt: result.acceptedAt },
      { status: 409 }
    );
  }
  if (result.error === "not_pending") {
    return Response.json({ ok: false, error: "not_pending" }, { status: 409 });
  }
  if (result.error === "conflict_retry_exhausted") {
    return Response.json({ ok: false, error: "conflict_retry_exhausted", message: "Please try again." }, { status: 409 });
  }

  // AWAITED — see orders.mjs / staff-orders.mjs for why fire-and-forget
  // push calls get silently killed by Netlify before they finish.
  await sendStaffPush({
    type: "order_accepted",
    orderId: result.order.id,
    acceptedByName: result.order.acceptedByName
  });

  return Response.json({ ok: true, item: result.order });
}

export const config = {
  path: "/api/staff-orders/accept",
  method: ["POST"]
};
