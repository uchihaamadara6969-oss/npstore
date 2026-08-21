/* ═══════════════════════════════════════════════════════════════════
   NP MART — PUBLIC SITE STATUS
   ───────────────────────────────────────────────────────────────────
   Public, read-only, no cookie required. Lets index.html ask "is the
   site open right now?" on load without exposing the full developer
   config (adminPanelEnabled is deliberately left out — that's nobody
   the public needs to know about).

   This is a convenience for the FRONTEND (so it can show a clean
   "we'll be right back" page instead of a broken one). The actual
   enforcement that can't be bypassed lives server-side in
   products.mjs (GET), orders.mjs (POST) and ai-chef.mjs, which each
   check the same site config directly.
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { STORE_NAME, loadSiteConfig } from "./_lib/siteConfig.mjs";

export default async (req) => {
  try {
    const store = getStore(STORE_NAME);
    const config = await loadSiteConfig(store);
    return Response.json({
      ok: true,
      maintenanceMode: config.maintenanceMode,
      maintenanceMessage: config.maintenanceMessage,
      ordersEnabled: config.ordersEnabled,
      aiChefEnabled: config.aiChefEnabled
    });
  } catch (err) {
    console.error("[site-status] unhandled error", err);
    // Fail OPEN — a config-read hiccup should never itself take the
    // storefront down.
    return Response.json({
      ok: true,
      maintenanceMode: false,
      maintenanceMessage: "",
      ordersEnabled: true,
      aiChefEnabled: true
    });
  }
};

export const config = {
  path: "/api/site-status",
  method: ["GET"]
};
