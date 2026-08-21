/* ═══════════════════════════════════════════════════════════════════
   NP MART — PUBLIC ORDER STATUS LOOKUP
   ───────────────────────────────────────────────────────────────────
   Lets a customer check their own order's live status from the
   storefront's "My Past Orders" drawer, WITHOUT exposing the full
   admin order record (no address, no other customers' data).

   GET /api/order-status?id=o00001&phone=9876543210   PUBLIC
     Both id and phone must be supplied and phone must match the
     order's stored phone number. Order ids are short sequential
     strings (o00001, o00002, ...) which are guessable, so the phone
     check is a deliberate, lightweight speed bump against someone
     enumerating ids to read a stranger's order — not bank-grade
     security, but appropriate for a small local kirana store where
     the worst case is "which items did another neighbour order."

   Returns only: id, status, createdAt, itemCount, total,
   acceptedByName (first name only, for a friendly "being handled by
   ___" touch), and statusHistory trimmed to { status, at } (no staff
   identities beyond acceptedByName above).
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "npmart-orders";
const BLOB_KEY = "orders.json";

async function loadOrders(store) {
  const orders = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(orders) ? orders : [];
}

function normalizePhone(p) {
  return String(p || "").replace(/\D/g, "").slice(-10);
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[order-status] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handle(req) {
  if (req.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim().toLowerCase();
  const phone = normalizePhone(url.searchParams.get("phone"));

  if (!id || !phone) {
    return Response.json({ ok: false, error: "id_and_phone_required" }, { status: 400 });
  }

  const store = getStore(STORE_NAME);
  const orders = await loadOrders(store);
  const order = orders.find((o) => String(o.id).toLowerCase() === id);

  if (!order || normalizePhone(order.phone) !== phone) {
    // Same error for "not found" and "phone mismatch" — don't leak
    // which one it was.
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const itemCount = Array.isArray(order.items)
    ? order.items.reduce((sum, it) => sum + (Number(it.qty) || 1), 0)
    : 0;

  const acceptedFirstName = order.acceptedByName
    ? String(order.acceptedByName).trim().split(/\s+/)[0]
    : null;

  const statusHistory = Array.isArray(order.statusHistory)
    ? order.statusHistory.map((h) => ({ status: h.status, at: h.at }))
    : [];

  return Response.json({
    ok: true,
    order: {
      id: order.id,
      status: order.status,
      createdAt: order.createdAt,
      itemCount,
      total: order.total,
      acceptedByName: acceptedFirstName,
      statusHistory
    }
  });
}

export const config = {
  path: "/api/order-status"
};
