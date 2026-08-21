/* ═══════════════════════════════════════════════════════════════════
   NP MART — ORDER HISTORY API
   ───────────────────────────────────────────────────────────────────
   Records every checkout so you (the shop owner) have a permanent,
   searchable order history with customer name/phone/address — not
   just whatever WhatsApp messages happen to still be in your chat.

   This does NOT change how orders reach you day-to-day: the customer
   still taps "Send Order on WhatsApp" and it opens WhatsApp exactly as
   before (see buildWhatsAppMessage() in index.html). This endpoint is
   called alongside that, fire-and-forget, purely to save a copy here.

   Endpoints:
     POST   /api/orders     PUBLIC — any checkout can create an order.
              Body: { customerName, phone, address,
                      items: [{ id, name, unit, qty, price }],
                      subtotal, delivery, total }
              Contains customer PII (name/phone/address) but so does
              every WhatsApp order message already sent today — same
              trust model as the existing checkout flow. Inputs are
              length-capped and type-checked, not otherwise verified.

     GET    /api/orders     ADMIN-ONLY (contains customer PII — must
              never be public read). ?q=, ?status=new|packed|
              out_for_delivery|delivered|cancelled, ?page=&pageSize=
              (default 50, max 200), ?all=1. Sorted newest first.

     PATCH  /api/orders     ADMIN-ONLY. Body: { id, status } and/or
              { id, notes }. Updates one order.

     DELETE /api/orders?id=o00001   ADMIN-ONLY.

   NOTE (Hostinger migration): like products.mjs, this uses
   @netlify/blobs and will need rebuilding against MySQL/PHP whenever
   the site moves off Netlify.
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { verifySession } from "./_lib/auth.mjs";
import { sendStaffPush } from "./_lib/push.mjs";

const STORE_NAME = "npmart-orders";
const BLOB_KEY = "orders.json";
const MAX_PAGE_SIZE = 200;
// "new" = pending staff approval (customer-facing: "Order Received").
// "approved"/"packing" were added for the staff order-alert app (see
// staff-orders.mjs) — a staff member accepting an order moves it
// new -> approved, then it's advanced through packing -> packed ->
// out_for_delivery -> delivered from the staff app. Kept "new" as the
// internal key (rather than renaming to "pending_approval") so the
// existing admin panel filter/status-select didn't need a rewrite.
const VALID_STATUSES = ["new", "approved", "packing", "packed", "out_for_delivery", "delivered", "cancelled"];
const MAX_ITEMS = 200;

async function loadOrders(store) {
  const orders = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(orders) ? orders : [];
}

async function saveOrders(store, orders) {
  await store.setJSON(BLOB_KEY, orders);
}

function nextId(orders) {
  let max = 0;
  for (const o of orders) {
    const m = /^o(\d+)$/i.exec(String(o.id || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "o" + String(max + 1).padStart(5, "0");
}

function trimTo(v, maxLen) {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

function toNumberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).map((it) => ({
    id: trimTo(it?.id, 40),
    name: trimTo(it?.name, 200),
    unit: trimTo(it?.unit, 40),
    qty: Math.max(1, Math.round(toNumberOrZero(it?.qty)) || 1),
    price: toNumberOrZero(it?.price)
  })).filter((it) => it.name);
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[orders] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handle(req) {
  const store = getStore(STORE_NAME);
  const url = new URL(req.url);

  // ─── Public: create an order (checkout) ───────────────────────────
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const customerName = trimTo(body?.customerName, 200);
    const phone = trimTo(body?.phone, 30);
    const address = trimTo(body?.address, 500);
    const items = sanitizeItems(body?.items);

    if (!customerName || !phone || !address || !items.length) {
      return Response.json(
        { ok: false, error: "missing_fields", message: "customerName, phone, address and at least one item are required." },
        { status: 400 }
      );
    }

    const orders = await loadOrders(store);
    const order = {
      id: nextId(orders),
      createdAt: new Date().toISOString(),
      status: "new",
      customerName,
      phone,
      address,
      items,
      subtotal: toNumberOrZero(body?.subtotal),
      delivery: toNumberOrZero(body?.delivery),
      total: toNumberOrZero(body?.total),
      notes: "",
      // Staff order-alert app fields — empty until a staff member
      // accepts it (see staff-orders.mjs POST /accept).
      acceptedBy: null,
      acceptedByName: null,
      acceptedAt: null,
      statusHistory: [{ status: "new", byStaffId: null, byStaffName: null, at: new Date().toISOString() }]
    };

    orders.unshift(order);
    await saveOrders(store, orders);

    // Rings every staff phone. AWAITED deliberately — Netlify's function
    // runtime can tear down the execution environment right after the
    // Response is returned, which would silently kill an un-awaited
    // "fire-and-forget" push call before its network requests (OAuth
    // token exchange + the actual FCM send) ever complete. sendStaffPush()
    // never throws — it catches everything internally and returns
    // {ok:false, ...} on any failure — so awaiting it adds a little
    // latency but can never fail or block order creation itself.
    await sendStaffPush({
      type: "new_order",
      orderId: order.id,
      customerName: order.customerName,
      total: order.total,
      itemCount: order.items.length
    });

    return Response.json({ ok: true, id: order.id }, { status: 201 });
  }

  // ─── Everything below reads/writes customer PII — admin only ──────
  const session = verifySession(req);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (req.method === "GET") {
    const orders = await loadOrders(store);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const status = (url.searchParams.get("status") || "").trim().toLowerCase();

    let items = orders;
    if (q) {
      items = items.filter((o) =>
        (o.customerName || "").toLowerCase().includes(q) ||
        (o.phone || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q)
      );
    }
    if (status) items = items.filter((o) => (o.status || "").toLowerCase() === status);

    if (url.searchParams.get("all")) {
      return Response.json({ ok: true, total: items.length, items });
    }

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10) || 50)
    );
    const start = (page - 1) * pageSize;

    return Response.json({
      ok: true,
      total: items.length,
      page,
      pageSize,
      items: items.slice(start, start + pageSize)
    });
  }

  if (req.method === "PATCH") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const id = trimTo(body?.id, 40).toLowerCase();
    if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

    const orders = await loadOrders(store);
    const order = orders.find((o) => String(o.id).toLowerCase() === id);
    if (!order) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

    if (typeof body.status === "string") {
      const status = body.status.trim().toLowerCase();
      if (!VALID_STATUSES.includes(status)) {
        return Response.json(
          { ok: false, error: "invalid_status", message: "status must be one of: " + VALID_STATUSES.join(", ") },
          { status: 400 }
        );
      }
      order.status = status;
      // Same audit trail the staff app writes to (see staff-orders.mjs)
      // — an admin override shows up in the same history, just with a
      // null staff identity so it's clearly distinguishable as "changed
      // from the admin panel" rather than by a staff member.
      if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
      order.statusHistory.push({ status, byStaffId: null, byStaffName: "Admin", at: new Date().toISOString() });
    }
    if (typeof body.notes === "string") {
      order.notes = body.notes.trim().slice(0, 1000);
    }

    await saveOrders(store, orders);
    return Response.json({ ok: true, item: order });
  }

  if (req.method === "DELETE") {
    const id = (url.searchParams.get("id") || "").trim().toLowerCase();
    if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

    const orders = await loadOrders(store);
    const idx = orders.findIndex((o) => String(o.id).toLowerCase() === id);
    if (idx === -1) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

    const [removed] = orders.splice(idx, 1);
    await saveOrders(store, orders);
    return Response.json({ ok: true, removed });
  }

  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export const config = {
  path: "/api/orders",
  method: ["GET", "POST", "PATCH", "DELETE"]
};
