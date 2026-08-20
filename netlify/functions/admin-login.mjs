/* ═══════════════════════════════════════════════════════════════════
   NP MART — ADMIN LOGIN
   Checks the password against ADMIN_PASSWORD and, if correct, hands
   back a signed session cookie. See _lib/auth.mjs for the full auth
   design and the env vars this needs.
   ═══════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { SESSION_TTL_MS, sessionCookieHeader } from "./_lib/auth.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const secret = process.env.ADMIN_SESSION_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!secret || !adminPassword) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message:
          "Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in Netlify (Site config > Environment variables, scope: Functions), then redeploy."
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
  const b = Buffer.from(adminPassword);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) {
    return Response.json({ ok: false, error: "invalid_password" }, { status: 401 });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", sessionCookieHeader(secret, SESSION_TTL_MS / 1000));

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};

export const config = {
  path: "/api/admin-login",
  method: ["POST"]
};
