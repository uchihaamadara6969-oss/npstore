/* NP MART — DEVELOPER LOGOUT: clears the npmart_dev cookie. */

import { clearDevCookieHeader } from "./_lib/auth.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", clearDevCookieHeader());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};

export const config = {
  path: "/api/dev-logout",
  method: ["POST"]
};
