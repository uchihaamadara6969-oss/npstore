/* ═══════════════════════════════════════════════════════════════════
   NP MART — PRODUCT CATALOG API
   ───────────────────────────────────────────────────────────────────
   Source of truth for the product catalog, backed by Netlify Blobs
   (a key-value store built into Netlify — no separate database to
   set up). The first request ever made seeds the store from the
   snapshot in data/products-seed.json (extracted from the catalog
   that used to be hard-coded inside index.html); every request after
   that reads/writes the live Blobs copy. See _lib/catalog.mjs for the
   shared load/save logic (also used by taxonomy.mjs).

   Endpoints:
     GET    /api/products              public, read-only.
              ?q=milk                  filter by name/id
              ?page=1&pageSize=50      paginate (default) — for the
                                       admin table
              ?all=1                   skip pagination, return every
                                       matching product — used by the
                                       storefront itself once it's
                                       wired to fetch live data
              ?category=food           filter by category (exact,
              ?sub=snacks              case-insensitive). Combine with
              ?micro=popcorn           q for search-within-category.
     PATCH  /api/products              admin-only. Body:
              { "updates": [{ "id": "a12345", "price": 99, "mrp": 120,
                              "stock": 10, "name": "...", "unit": "...",
                              "company": "...", "category": "food",
                              "sub": "snacks", "micro": "popcorn" }] }
              Any field left out is untouched. Send "" for category to
              reset a product back to uncategorized ("general"); send
              "" for sub/micro to clear just that level. Unknown ids
              are ignored. This is also how bulk category assignment
              works — send one update object per selected product id,
              all with the same category/sub/micro.
     POST   /api/products              admin-only. Body: a single new
              product { name, unit, price, mrp, stock }. An id is
              generated automatically.
     DELETE /api/products?id=a12345    admin-only. Removes one product.

   NOTE (per your Hostinger migration plan): this file is Netlify-only
   — it uses @netlify/blobs, which has no equivalent on Hostinger
   shared hosting. When you move, this whole data layer gets rebuilt
   against MySQL + PHP (or whatever Hostinger gives you); nothing here
   is meant to survive that move as-is.
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { verifySession } from "./_lib/auth.mjs";
import { STORE_NAME, loadCatalog, saveCatalog } from "./_lib/catalog.mjs";

const MAX_PAGE_SIZE = 200;

function nextId(catalog) {
  let max = 0;
  for (const p of catalog) {
    const m = /^a(\d+)$/i.exec(String(p.id || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "a" + String(max + 1).padStart(5, "0");
}

function toNumberOrUndefined(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Trimmed + lowercased taxonomy value, or null for "clear this level".
// Returns undefined (meaning "leave untouched") when the field wasn't
// sent at all, so PATCH can distinguish "don't touch category" from
// "clear category" from "set category".
function taxonomyValueOrUndefined(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim().toLowerCase();
  return s ? s : null;
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    // Never let this fall through to a bare 502 — always answer with
    // JSON that says exactly what broke, so it's debuggable from the
    // browser Network tab instead of guessing blind.
    console.error("[products] unhandled error", err);
    return Response.json(
      {
        ok: false,
        error: "internal_error",
        message: String(err?.message || err),
        stack: err?.stack ? String(err.stack).split("\n").slice(0, 5) : undefined
      },
      { status: 500 }
    );
  }
};

async function handle(req) {
  const store = getStore(STORE_NAME);
  const url = new URL(req.url);

  // ─── Public read ────────────────────────────────────────────────
  if (req.method === "GET") {
    const catalog = await loadCatalog(store);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const category = (url.searchParams.get("category") || "").trim().toLowerCase();
    const sub = (url.searchParams.get("sub") || "").trim().toLowerCase();
    const micro = (url.searchParams.get("micro") || "").trim().toLowerCase();
    const status = (url.searchParams.get("status") || "").trim().toLowerCase(); // "categorized" | "uncategorized"

    let items = catalog;
    if (q) {
      items = items.filter(
        (p) =>
          p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
      );
    }
    if (category) items = items.filter((p) => (p.category || "").toLowerCase() === category);
    if (sub) items = items.filter((p) => (p.sub || "").toLowerCase() === sub);
    if (micro) items = items.filter((p) => (p.micro || "").toLowerCase() === micro);
    if (status === "uncategorized") items = items.filter((p) => !p.category || p.category === "general");
    if (status === "categorized") items = items.filter((p) => p.category && p.category !== "general");

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

  // ─── Everything below writes data — admin session required ───────
  const session = verifySession(req);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (req.method === "PATCH") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const updates = Array.isArray(body?.updates) ? body.updates : [body];
    if (!updates.length) {
      return Response.json({ ok: false, error: "no_updates" }, { status: 400 });
    }

    const catalog = await loadCatalog(store);
    const byId = new Map(catalog.map((p) => [p.id.toLowerCase(), p]));
    const changed = [];

    for (const u of updates) {
      const p = byId.get(String(u?.id || "").toLowerCase());
      if (!p) continue;

      const price = toNumberOrUndefined(u.price);
      const mrp = toNumberOrUndefined(u.mrp);
      const stock = toNumberOrUndefined(u.stock);

      if (price !== undefined) p.price = price;
      if (mrp !== undefined) p.mrp = mrp;
      if (stock !== undefined) p.stock = Math.max(0, Math.round(stock));
      if (typeof u.name === "string" && u.name.trim()) p.name = u.name.trim();
      if (typeof u.unit === "string" && u.unit.trim()) p.unit = u.unit.trim();
      // Company/brand — a separate manually-assigned field (older seeded
      // products have no company at all; the storefront still guesses a
      // brand from the product name for its "All Companies" filter, but
      // this is the real, admin-set value). Sent as "" clears it.
      if (typeof u.company === "string") p.company = u.company.trim();

      // Taxonomy: category/sub/micro. undefined = untouched, null/"" =
      // clear that level, a string = set it. Clearing category resets
      // to "general" (our "uncategorized" marker) rather than null, so
      // it stays consistent with every product's original shape.
      const category = taxonomyValueOrUndefined(u.category);
      if (category !== undefined) p.category = category || "general";
      const sub = taxonomyValueOrUndefined(u.sub);
      if (sub !== undefined) p.sub = sub;
      const micro = taxonomyValueOrUndefined(u.micro);
      if (micro !== undefined) p.micro = micro;

      // A product with no category can't meaningfully have a sub or
      // micro category under it — cascade-clear so it doesn't end up
      // in a dangling state (e.g. "general" but still "sub: snacks").
      // Only cascades when the caller didn't explicitly set a new
      // sub/micro in this same request.
      if (p.category === "general") {
        if (sub === undefined) p.sub = null;
        if (micro === undefined) p.micro = null;
      }

      changed.push(p);
    }

    if (!changed.length) {
      return Response.json({ ok: false, error: "no_matching_products" }, { status: 404 });
    }

    await saveCatalog(store, catalog);
    return Response.json({ ok: true, updated: changed.length, items: changed });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return Response.json({ ok: false, error: "name_required" }, { status: 400 });
    }

    const catalog = await loadCatalog(store);
    const product = {
      id: nextId(catalog),
      name,
      unit: typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : "1 pc",
      price: toNumberOrUndefined(body.price) ?? 0,
      mrp: toNumberOrUndefined(body.mrp) ?? toNumberOrUndefined(body.price) ?? 0,
      stock: Math.max(0, Math.round(toNumberOrUndefined(body.stock) ?? 0)),
      company: typeof body.company === "string" ? body.company.trim() : "",
      category: "general",
      sub: null,
      micro: null
    };

    catalog.push(product);
    await saveCatalog(store, catalog);
    return Response.json({ ok: true, item: product }, { status: 201 });
  }

  if (req.method === "DELETE") {
    const id = (url.searchParams.get("id") || "").toLowerCase();
    if (!id) {
      return Response.json({ ok: false, error: "id_required" }, { status: 400 });
    }

    const catalog = await loadCatalog(store);
    const idx = catalog.findIndex((p) => p.id.toLowerCase() === id);
    if (idx === -1) {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    const [removed] = catalog.splice(idx, 1);
    await saveCatalog(store, catalog);
    return Response.json({ ok: true, removed });
  }

  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export const config = {
  path: "/api/products",
  method: ["GET", "PATCH", "POST", "DELETE"]
};
