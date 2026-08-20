/* NP MART — ADMIN SESSION CHECK: lets the admin page ask "am I still
   logged in?" on load without touching product data. */

import { verifySession } from "./_lib/auth.mjs";

export default async (req) => {
  const session = verifySession(req);
  if (!session) {
    return Response.json({ ok: false, loggedIn: false }, { status: 401 });
  }
  return Response.json({ ok: true, loggedIn: true, expiresAt: session.exp });
};

export const config = {
  path: "/api/admin-me",
  method: ["GET"]
};
