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
