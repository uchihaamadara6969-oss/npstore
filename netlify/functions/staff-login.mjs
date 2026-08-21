/* ═══════════════════════════════════════════════════════════════════
   NP MART — STAFF LOGIN (order-alert app)
   Checks a username+password against the npmart-staff Blobs store
   (see staff-accounts.mjs) and, if correct, hands back a signed staff
   session cookie identifying WHICH staff member is logged in — that
   identity is what lets accept/pack/dispatch actions be attributed
   to a real person later. See _lib/auth.mjs for the session design.
   ═══════════════════════════════════════════════════════════════════ */

import { STAFF_SESSION_TTL_MS, staffSessionCookieHeader } from "./_lib/auth.mjs";
import { getStore } from "@netlify/blobs";
import { loadStaff, verifyPassword, STAFF_STORE_NAME } from "./staff-accounts.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message: "Set ADMIN_SESSION_SECRET in Netlify (Site config > Environment variables, scope: Functions), then redeploy."
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

  const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) {
    return Response.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const store = getStore(STAFF_STORE_NAME);
  const staff = await loadStaff(store);
  const account = staff.find((s) => s.username === username);

  // Same response whether the username doesn't exist or the password
  // is wrong — don't leak which one it was.
  if (!account || account.active === false || !verifyPassword(password, account.passwordHash)) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    staffSessionCookieHeader(secret, STAFF_SESSION_TTL_MS / 1000, account.id, account.name)
  );

  return new Response(
    JSON.stringify({ ok: true, staffId: account.id, staffName: account.name }),
    { status: 200, headers }
  );
};

export const config = {
  path: "/api/staff-login",
  method: ["POST"]
};
