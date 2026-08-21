/* ═══════════════════════════════════════════════════════════════════
   NP MART — MARG ERP STOCK & RATES IMPORT
   ───────────────────────────────────────────────────────────────────
   Parses the fixed-width "STOCK & RATES STATEMENT" .txt report Marg
   ERP exports and applies ONLY price (Rate/MRP) + stock (Qty) to the
   matching product in the real catalog — matched by product code
   (Marg's "ITEM DESCRIPTION" leading token), never by name. Nothing
   else about a product (name, unit, category, company, photo) is
   ever touched by this import.

   Report shape (confirmed against a real 18,559-line / 15,813-row
   export from this store):
     CODE   Description text                    QTY    MRP    RATE   AMOUNT   COST   AMOUNT   NET   AMOUNT
   Columns are separated by 2+ spaces; the trailing 8 columns are
   always numeric-ish tokens (a plain number, a decimal, or "-").
   Everything else — page headers repeated every page, "Continued..N"
   footers, the dashed rules, the final TOTAL/"End of Report" lines —
   doesn't match that shape and is simply skipped, not guessed at.

   Stock (Qty) rule, exactly as the shop owner specified:
     "-"            -> 0 (out of stock)
     a negative num -> 0 (out of stock)
     a real number  -> that many in stock (decimals round, e.g. loose-
                        weight items like rice/atta sold by the kg)

   Price (Rate) rule: applied normally EXCEPT when Rate is exactly
   0.00 — Marg uses that to mean "no sale rate set on this item", not
   "sell it for free". Applying it literally would silently zero out
   a real price on the live storefront, so that one field is left
   untouched and the product is flagged in zeroRateFlagged instead
   for the shop owner to check by hand. MRP and stock still update
   normally even when Rate is 0.00.

   Special cases surfaced, never guessed at:
     - Codes starting with "###" (LABOUR, PACKING EXP, SERVICE CHARGE,
       POST&COURIER, etc.) are Marg's own accounting line items, not
       products — skipped entirely (skippedNonProduct count).
     - A code appearing more than once in the file, attached to
       DIFFERENT product names, means Marg reassigned that code to a
       new item without the site's catalog being told — applying
       either row's numbers to the existing product would silently
       attach the wrong item's price/stock to it. Skipped and listed
       in skippedAmbiguousDuplicateCode for manual review instead.
     - A code that matches no product already in the catalog is a
       genuinely new item — surfaced in newItems (with its parsed
       name/mrp/price/stock) rather than auto-created, since it has
       no category/company/unit-normalization yet.
   ═══════════════════════════════════════════════════════════════════ */

const NUM_TOKEN_RE = /^-?\d+(\.\d+)?$|^-$/;

function parseQtyToStock(raw) {
  if (raw === "-") return 0;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.max(0, Math.round(n));
}

/**
 * @param {string} text  Raw contents of the Marg .txt export.
 * @param {Array}  catalog  The live product catalog array — matching
 *   products are mutated IN PLACE (stock always, mrp always, price
 *   only when Rate > 0). Caller is responsible for saving it back.
 * @returns {object} Summary of what happened, for the admin UI.
 */
export function runMargImport(text, catalog) {
  const byId = new Map(catalog.map((p) => [String(p.id).toLowerCase(), p]));

  const lines = String(text || "").split(/\r\n|\r|\n/);
  const rows = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const parts = line.split(/\s{2,}/).filter((s) => s.length);
    if (parts.length < 2) continue;

    const tail = parts.slice(-8);
    if (tail.length !== 8 || !tail.every((t) => NUM_TOKEN_RE.test(t.trim()))) continue;

    const head = parts.slice(0, -8).join(" ").trim();
    const m = /^(\S+)\s+(.*)$/.exec(head);
    if (!m) continue;

    rows.push({ code: m[1], desc: m[2].trim(), qtyRaw: tail[0], mrpRaw: tail[1], rateRaw: tail[2] });
  }

  const byCode = new Map();
  for (const r of rows) {
    const key = r.code.toLowerCase();
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(r);
  }

  const updated = [];
  const skippedAmbiguousDuplicateCode = [];
  const zeroRateFlagged = [];
  const newItems = [];
  let skippedNonProduct = 0;

  for (const [codeLower, occs] of byCode) {
    if (codeLower.startsWith("###")) {
      skippedNonProduct += occs.length;
      continue;
    }
    if (occs.length > 1) {
      skippedAmbiguousDuplicateCode.push({ code: occs[0].code, occurrences: occs.map((o) => o.desc) });
      continue;
    }

    const r = occs[0];
    const product = byId.get(codeLower);
    const mrp = parseFloat(r.mrpRaw);
    const rate = parseFloat(r.rateRaw);
    const stock = parseQtyToStock(r.qtyRaw);

    if (!product) {
      newItems.push({ code: r.code, name: r.desc, mrp, price: rate, stock });
      continue;
    }

    product.stock = stock;
    if (Number.isFinite(mrp)) product.mrp = mrp;
    if (Number.isFinite(rate) && rate > 0) {
      product.price = rate;
    } else {
      zeroRateFlagged.push({ id: product.id, name: product.name, mrp: product.mrp });
    }

    updated.push({ id: product.id, name: product.name, stock: product.stock, mrp: product.mrp, price: product.price });
  }

  return {
    totalRows: rows.length,
    updated,
    skippedNonProduct,
    skippedAmbiguousDuplicateCode,
    zeroRateFlagged,
    newItems,
    catalog
  };
}
