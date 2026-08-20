/* ═══════════════════════════════════════════════════════════════════
   NP MART — CATEGORY TREE API
   ───────────────────────────────────────────────────────────────────
   Public, read-only. Computes the live category → subcategory →
   microcategory tree directly from the product catalog (there's no
   separate "list of categories" to maintain — a category exists
   exactly when at least one product is assigned to it, same as the
   reference category-manager tool this was modeled on).

   GET /api/taxonomy
     -> { ok:true, total, uncategorized,
          tree: { "<category>": { count, subs: { "<sub>": { count,
                    micros: { "<micro>": count } } } } } }
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { STORE_NAME, loadCatalog } from "./_lib/catalog.mjs";

export default async (req) => {
  try {
    const store = getStore(STORE_NAME);
    const catalog = await loadCatalog(store);

    const tree = {};
    let uncategorized = 0;

    for (const p of catalog) {
      if (!p.category || p.category === "general") {
        uncategorized++;
        continue;
      }
      const cat = tree[p.category] || (tree[p.category] = { count: 0, subs: {} });
      cat.count++;
      if (p.sub) {
        const sub = cat.subs[p.sub] || (cat.subs[p.sub] = { count: 0, micros: {} });
        sub.count++;
        if (p.micro) {
          sub.micros[p.micro] = (sub.micros[p.micro] || 0) + 1;
        }
      }
    }

    return Response.json({ ok: true, total: catalog.length, uncategorized, tree });
  } catch (err) {
    console.error("[taxonomy] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

export const config = {
  path: "/api/taxonomy",
  method: ["GET"]
};
