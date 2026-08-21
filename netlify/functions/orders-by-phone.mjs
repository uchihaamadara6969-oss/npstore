/* ═══════════════════════════════════════════════════════════════════
   NP MART — "MY ORDERS" BY PHONE NUMBER (PUBLIC, NO LOGIN)
   ───────────────────────────────────────────────────────────────────
   NP Mart doesn't have customer accounts/passwords — a customer's
   phone number IS their identity here, exactly like it always was
   over WhatsApp. This endpoint lets the storefront's "My Orders"
   screen look up everything placed under a phone number, from ANY
   device/browser (the old approach only remembered orders in that
   one browser's local storage, which broke the moment someone
   cleared their cache or ordered from a different phone).

   GET /api/orders-by-phone?phone=9876543210   PUBLIC
     Returns up to the 20 most recent orders for that phone, plus
     the name/address from their most recent order so the storefront
     can auto-fill the checkout form next time. No password — same
     trust model as the phone number you'd already give over
     WhatsApp. Deliberately excludes nothing from a customer's OWN
     orders (unlike order-status.mjs which strips staff identities
     for a stranger-safe single-order lookup); this endpoint only
     ever returns orders that already belong to the phone number the
     caller supplied.
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "npmart-orders";
const BLOB_KEY = "orders.json";
const MAX_ORDERS = 20;

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
    console.error("[orders-by-phone] unhandled error", err);
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
  const phone = normalizePhone(url.searchParams.get("phone"));
  if (phone.length < 10) {
    return Response.json({ ok: false, error: "valid_phone_required" }, { status: 400 });
  }

  const store = getStore(STORE_NAME);
  const allOrders = await loadOrders(store);
  const mine = allOrders
    .filter((o) => normalizePhone(o.phone) === phone)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, MAX_ORDERS);

  const orders = mine.map((o) => ({
    id: o.id,
    status: o.status,
    createdAt: o.createdAt,
    total: o.total,
    items: Array.isArray(o.items) ? o.items : [],
    acceptedByName: o.acceptedByName || null
  }));

  // Most recent order's name/address, for autofilling the checkout form.
  const customer = mine.length ? { name: mine[0].customerName, address: mine[0].address } : null;

  return Response.json({ ok: true, customer, orders });
}

export const config = {
  path: "/api/orders-by-phone"
};
