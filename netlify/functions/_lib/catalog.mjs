/* ═══════════════════════════════════════════════════════════════════
   NP MART — SHARED CATALOG LOAD/SAVE
   Used by products.mjs and taxonomy.mjs so both read/write the exact
   same Blobs store the exact same way. The seed catalog is imported
   at build time (not read from disk at runtime) — see products.mjs's
   top comment for why; that was the cause of an earlier production
   bug (/api/products 502ing) and this pattern avoids repeating it.
   ═══════════════════════════════════════════════════════════════════ */

import SEED_CATALOG from "../data/products-seed.json" with { type: "json" };

export const STORE_NAME = "npmart-catalog";
export const BLOB_KEY = "products.json";

export async function loadCatalog(store) {
  let catalog = await store.get(BLOB_KEY, { type: "json" });
  if (!catalog) {
    catalog = SEED_CATALOG;
    await store.setJSON(BLOB_KEY, catalog);
  }
  return catalog;
}

export async function saveCatalog(store, catalog) {
  await store.setJSON(BLOB_KEY, catalog);
}

/* Applies live stock deltas (negative to decrement when an order is
   placed, positive to restore when an order is cancelled) as one atomic
   conditional write per attempt — same etag-conditional-write + retry
   pattern used for the staff accept-order race fix, since concurrent
   checkouts hitting this at once is the exact same class of lost-update
   race. Unknown ids are silently skipped (product may have been
   deleted); stock never goes below 0. Never throws — a stock-adjustment
   hiccup should never fail an order that's already been placed/saved,
   so callers should await this but don't need to wrap it defensively. */
export async function adjustStock(store, deltas) {
  const list0 = (deltas || []).filter((d) => d && d.id && Number.isFinite(d.delta) && d.delta !== 0);
  if (!list0.length) return;

  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const { data, etag } = await store.getWithMetadata(BLOB_KEY, { type: "json" });
      const catalog = Array.isArray(data) ? data : SEED_CATALOG;
      const byId = new Map(catalog.map((p) => [String(p.id).toLowerCase(), p]));

      for (const { id, delta } of list0) {
        const p = byId.get(String(id).toLowerCase());
        if (!p) continue;
        const current = Number(p.stock) || 0;
        p.stock = Math.max(0, current + delta);
      }

      await store.setJSON(BLOB_KEY, catalog, { onlyIfMatch: etag });
      return;
    } catch (err) {
      continue; // someone else wrote the catalog in between — retry with fresh data
    }
  }
  console.error("[catalog] adjustStock: conflict_retry_exhausted", list0);
}
