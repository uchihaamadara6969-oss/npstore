/* ═══════════════════════════════════════════════════════════════════
   NP MART — SITE CONFIG (developer kill-switches)
   ───────────────────────────────────────────────────────────────────
   One small JSON blob holding the toggles the developer panel
   controls. Read by the developer panel itself, by /api/site-status
   (public, tells the storefront what's on/off), and enforced INSIDE
   every function that toggle governs — not just hidden in the admin
   UI. Turning a switch off here genuinely blocks the corresponding
   feature at the API level, so it can't be bypassed by editing the
   page or calling the API directly.

   Fields:
     maintenanceMode     "Server busy" — when true, the storefront
                          shows a full-screen blocking page and
                          /api/products (GET) itself refuses to serve
                          the catalog. The developer panel and its own
                          login are NEVER gated by this — otherwise
                          turning the site off could lock you out of
                          turning it back on.
     maintenanceMessage  Optional custom text shown on the block page.
     ordersEnabled        false -> POST /api/orders (checkout) is
                          refused with a friendly message.
     aiChefEnabled        false -> POST /api/ai-chef (the actual
                          chat call, not the admin diagnostics) is
                          refused.
     adminPanelEnabled    false -> the regular admin panel (password
                          login + every admin-authenticated endpoint)
                          stops working for admin sessions. Developer
                          sessions are a separate, higher tier and are
                          never affected by this — see _lib/auth.mjs's
                          requireAdminOrDev().
   ═══════════════════════════════════════════════════════════════════ */

export const STORE_NAME = "npmart-site-config";
export const BLOB_KEY = "config.json";

export const DEFAULT_CONFIG = {
  maintenanceMode: false,
  maintenanceMessage: "",
  ordersEnabled: true,
  aiChefEnabled: true,
  adminPanelEnabled: true
};

export async function loadSiteConfig(store) {
  const cfg = await store.get(BLOB_KEY, { type: "json" });
  if (!cfg || typeof cfg !== "object") return { ...DEFAULT_CONFIG };
  // Merge over defaults so an older/partial blob never leaves a field
  // undefined (which would read as "falsy/off" in some checks and
  // "on" in others depending on how it's compared).
  return { ...DEFAULT_CONFIG, ...cfg };
}

export async function saveSiteConfig(store, config) {
  const clean = { ...DEFAULT_CONFIG, ...config };
  await store.setJSON(BLOB_KEY, clean);
  return clean;
}
