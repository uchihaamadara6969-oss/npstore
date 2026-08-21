/* ═══════════════════════════════════════════════════════════════════
   NP MART — DEVELOPER SETTINGS (the actual kill-switches)
   ───────────────────────────────────────────────────────────────────
   Developer-session-only (never accepts an admin session — this is
   the one tier above admin). Reads/writes the site config blob that
   /api/site-status exposes publicly (read-only, trimmed) and that
   every gated endpoint (products.mjs GET, orders.mjs POST, ai-chef.mjs,
   and every admin-write endpoint via requireAdminOrDev()) checks on
   every request.

   GET   /api/dev-settings   -> { ok:true, config: {...} }
   PATCH /api/dev-settings   Body: any subset of
     { maintenanceMode, maintenanceMessage, ordersEnabled,
       aiChefEnabled, adminPanelEnabled }
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { verifyDevSession } from "./_lib/auth.mjs";
import { STORE_NAME, loadSiteConfig, saveSiteConfig } from "./_lib/siteConfig.mjs";

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[dev-settings] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handle(req) {
  const session = verifyDevSession(req);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const store = getStore(STORE_NAME);

  if (req.method === "GET") {
    const config = await loadSiteConfig(store);
    return Response.json({ ok: true, config });
  }

  if (req.method === "PATCH") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const current = await loadSiteConfig(store);
    const next = { ...current };

    if (typeof body?.maintenanceMode === "boolean") next.maintenanceMode = body.maintenanceMode;
    if (typeof body?.ordersEnabled === "boolean") next.ordersEnabled = body.ordersEnabled;
    if (typeof body?.aiChefEnabled === "boolean") next.aiChefEnabled = body.aiChefEnabled;
    if (typeof body?.adminPanelEnabled === "boolean") next.adminPanelEnabled = body.adminPanelEnabled;
    if (typeof body?.maintenanceMessage === "string") {
      next.maintenanceMessage = body.maintenanceMessage.trim().slice(0, 500);
    }

    const saved = await saveSiteConfig(store, next);
    return Response.json({ ok: true, config: saved });
  }

  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export const config = {
  path: "/api/dev-settings",
  method: ["GET", "PATCH"]
};
