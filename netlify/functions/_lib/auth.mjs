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

/* ═══════════════════════════════════════════════════════════════════
   STAFF SESSIONS (separate cookie from the admin one above)
   ───────────────────────────────────────────────────────────────────
   Same signed-cookie mechanism as admin auth, but identifies WHICH
   staff member is logged in (id + name baked into the signed
   payload) and is deliberately a different cookie name so an admin
   session and a staff session never collide or get confused with
   each other — a browser/device can even hold both at once.

   Staff accounts are looked up by staff-login.mjs against the
   npmart-staff Blobs store (see staff-accounts.mjs) — this file only
   knows how to sign/verify the resulting session, not how accounts
   are stored.

   Uses the SAME ADMIN_SESSION_SECRET env var to sign — one secret
   for the whole site is enough since both cookies are HttpOnly and
   scoped separately by name; no need for a second secret.
   ═══════════════════════════════════════════════════════════════════ */

export const STAFF_COOKIE_NAME = "npmart_staff";
export const STAFF_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — work device, not re-logging in daily

export function staffSessionCookieHeader(secret, maxAgeSeconds, staffId, staffName) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + maxAgeSeconds * 1000, staffId, staffName })
  ).toString("base64url");
  const token = sign(payload, secret);
  return `${STAFF_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearStaffCookieHeader() {
  return `${STAFF_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Returns { staffId, staffName, exp } if the request carries a valid,
 * unexpired, correctly-signed staff cookie — or null. Mirrors
 * verifySession() above but reads the staff cookie/name instead.
 */
export function verifyStaffSession(req) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return null;

  const token = parseCookies(req)[STAFF_COOKIE_NAME];
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
    if (!data.exp || data.exp < Date.now() || !data.staffId) return null;
    return data;
  } catch {
    return null;
  }
}
