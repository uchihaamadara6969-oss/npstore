/* ═══════════════════════════════════════════════════════════════════
   NP MART — BULK PRICE + STOCK IMPORT (Marg ERP export)
   ───────────────────────────────────────────────────────────────────
   Admin-only. Body: { text: "<raw contents of the Marg .txt export>" }

   Paste/upload the shop's "STOCK & RATES STATEMENT" export from Marg
   ERP and this updates ONLY price (Rate/MRP) + stock (Qty) on the
   matching products in the live catalog, matched by product code —
   never by name, and nothing else about a product is touched. See
   _lib/margImport.mjs for the exact parsing/matching rules, all of
   them worked out against a real export from this store rather than
   guessed.

   Returns a summary so the admin panel can show what happened:
     { ok:true, summary: {
         totalRows, updatedCount,
         skippedNonProduct,               // Marg's own LABOUR/SERVICE
                                           // CHARGE/etc. accounting rows
         skippedAmbiguousDuplicateCode,   // code reused for a different
                                           // product name — needs a human
         zeroRateFlagged,                 // Rate was 0.00 — price left
                                           // untouched, only stock/MRP set
         newItems                         // code not in the catalog at
                                           // all yet — NOT auto-created
     } }
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { requireAdminOrDev } from "./_lib/auth.mjs";
import { STORE_NAME, loadCatalog, saveCatalog } from "./_lib/catalog.mjs";
import { runMargImport } from "./_lib/margImport.mjs";

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[products-import] unhandled error", err);
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

  const auth = await requireAdminOrDev(req);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) {
    return Response.json({ ok: false, error: "text_required" }, { status: 400 });
  }

  const store = getStore(STORE_NAME);
  const catalog = await loadCatalog(store);
  const result = runMargImport(text, catalog);

  await saveCatalog(store, result.catalog);

  return Response.json({
    ok: true,
    summary: {
      totalRows: result.totalRows,
      updatedCount: result.updated.length,
      skippedNonProduct: result.skippedNonProduct,
      skippedAmbiguousDuplicateCode: result.skippedAmbiguousDuplicateCode,
      zeroRateFlagged: result.zeroRateFlagged,
      newItems: result.newItems
    }
  });
}

export const config = {
  path: "/api/products-import",
  method: ["POST"]
};
