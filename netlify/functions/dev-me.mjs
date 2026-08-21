/* NP MART — DEVELOPER SESSION CHECK: lets the developer page ask "am I
   still logged in?" on load. Deliberately checks the developer cookie
   ONLY (not verifyAdminOrDev) — an admin session should never be able
   to open the developer panel just because it's a lower tier. */

import { verifyDevSession } from "./_lib/auth.mjs";

export default async (req) => {
  const session = verifyDevSession(req);
  if (!session) {
    return Response.json({ ok: false, loggedIn: false }, { status: 401 });
  }
  return Response.json({ ok: true, loggedIn: true, expiresAt: session.exp });
};

export const config = {
  path: "/api/dev-me",
  method: ["GET"]
};
