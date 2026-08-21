/* ═══════════════════════════════════════════════════════════════════
   NP MART — DEVELOPER LOGIN
   Checks the password against DEV_PASSWORD (separate from
   ADMIN_PASSWORD) and, if correct, hands back a signed npmart_dev
   cookie. See _lib/auth.mjs for the full developer-session design.

   Deliberately NEVER gated by any site-config toggle (not
   maintenanceMode, not adminPanelEnabled) — this is the one door that
   must always open, or a toggle flipped the wrong way could lock you
   out of your own site with no way back in short of clearing Blobs
   by hand.
   ═══════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { DEV_SESSION_TTL_MS, devSessionCookieHeader } from "./_lib/auth.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const secret = process.env.ADMIN_SESSION_SECRET;
  const devPassword = process.env.DEV_PASSWORD;

  if (!secret || !devPassword) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message:
          "Set DEV_PASSWORD and ADMIN_SESSION_SECRET in Netlify (Site config > Environment variables, scope: Functions), then redeploy."
      },
      { status: 503 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const password = typeof body?.password === "string" ? body.password : "";

  // Constant-time comparison so response timing can't leak how many
  // characters matched.
  const a = Buffer.from(password);
  const b = Buffer.from(devPassword);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) {
    return Response.json({ ok: false, error: "invalid_password" }, { status: 401 });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", devSessionCookieHeader(secret, DEV_SESSION_TTL_MS / 1000));

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};

export const config = {
  path: "/api/dev-login",
  method: ["POST"]
};
