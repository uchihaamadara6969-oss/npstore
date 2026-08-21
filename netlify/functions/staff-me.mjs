/* NP MART — STAFF SESSION CHECK: lets the staff app ask "am I still
   logged in, and who as?" on launch without touching order data. */

import { verifyStaffSession } from "./_lib/auth.mjs";

export default async (req) => {
  const session = verifyStaffSession(req);
  if (!session) {
    return Response.json({ ok: false, loggedIn: false }, { status: 401 });
  }
  return Response.json({
    ok: true,
    loggedIn: true,
    staffId: session.staffId,
    staffName: session.staffName,
    expiresAt: session.exp
  });
};

export const config = {
  path: "/api/staff-me",
  method: ["GET"]
};
