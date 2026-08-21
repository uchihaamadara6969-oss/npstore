/* NP MART — ADMIN SESSION CHECK: lets the admin page ask "am I still
   logged in?" on load without touching product data. */

import { requireAdminOrDev } from "./_lib/auth.mjs";

export default async (req) => {
  const auth = await requireAdminOrDev(req);
  if (!auth.ok) {
    return Response.json({ ok: false, loggedIn: false }, { status: 401 });
  }
  return Response.json({ ok: true, loggedIn: true, role: auth.role });
};

export const config = {
  path: "/api/admin-me",
  method: ["GET"]
};
