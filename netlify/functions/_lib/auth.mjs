/* ═══════════════════════════════════════════════════════════════════
   NP MART — SHARED ADMIN AUTH HELPERS
   ───────────────────────────────────────────────────────────────────
   Small, dependency-free session system so we don't need a database
   just to know "is this the shop owner logged in?".

   How it works:
     1. POST /api/admin-login with the correct password gets you a
        signed, httpOnly cookie (npmart_admin). Nothing is stored
        server-side — the cookie itself carries an expiry, signed with
        ADMIN_SESSION_SECRET so it can't be forged or edited.
     2. Every write to /api/products (PATCH/POST/DELETE) calls
        verifySession() and rejects the request if the cookie is
        missing, expired, or the signature doesn't match.

   REQUIRED Netlify environment variables (Site config > Environment
   variables, scope: Functions):
     ADMIN_PASSWORD         the password you type on the /admin login
                             screen
     ADMIN_SESSION_SECRET    any long random string, used only to sign
                             the session cookie — never shown to users.
                             Generate one with e.g.
                             `openssl rand -hex 32` and paste it in.

   Like ai-chef.mjs: these are read at request time from Netlify's env,
   never hard-coded, and after adding/changing them you must redeploy.
   ═══════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

export const COOKIE_NAME = "npmart_admin";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function sign(payload, secret) {
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + sig;
}

function parseCookies(req) {
  const header = req.headers.get("cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

/**
 * Returns the decoded session payload (e.g. { exp }) if the request
 * carries a valid, unexpired, correctly-signed admin cookie — or null.
 */
export function verifySession(req) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return null;

  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;

  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;

  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function sessionCookieHeader(secret, maxAgeSeconds) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + maxAgeSeconds * 1000 })
  ).toString("base64url");
  const token = sign(payload, secret);
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
