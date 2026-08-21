/* ═══════════════════════════════════════════════════════════════════
   NP MART — STAFF ACCOUNTS (admin-only management)
   ───────────────────────────────────────────────────────────────────
   Lets the shop owner create/manage one login per staff member
   (Ankit, Rohit, Kavya, "Shop Phone", etc.) for the staff order-alert
   app. Every account is equal — there is no per-account permission
   tier here, because the staff app itself only ever exposes the
   order queue; there's nothing more sensitive to gate inside it.

   Passwords are stored salted+hashed (scrypt), never in plain text —
   unlike ADMIN_PASSWORD (a single env var), these live in Blobs
   alongside everything else since there can be any number of them.

   Endpoints (ALL admin-only — the shop owner manages staff accounts,
   staff members don't manage themselves):
     GET    /api/staff-accounts             list all (no password data)
     POST   /api/staff-accounts             create. Body: { name, username, password }
     PATCH  /api/staff-accounts             update. Body: { id, name?, username?, password?, active? }
     DELETE /api/staff-accounts?id=st00001  remove permanently

   NOTE (Hostinger migration): like the other *.mjs files, this uses
   @netlify/blobs and will need rebuilding against MySQL/PHP whenever
   the site moves off Netlify.
   ═══════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { verifySession } from "./_lib/auth.mjs";

const STORE_NAME = "npmart-staff";
const BLOB_KEY = "staff.json";

async function loadStaff(store) {
  const staff = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(staff) ? staff : [];
}

async function saveStaff(store, staff) {
  await store.setJSON(BLOB_KEY, staff);
}

function nextId(staff) {
  let max = 0;
  for (const s of staff) {
    const m = /^st(\d+)$/i.exec(String(s.id || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "st" + String(max + 1).padStart(5, "0");
}

function trimTo(v, maxLen) {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

/* scrypt with a random salt per password — dependency-free (Node's
   built-in crypto), same spirit as the HMAC signing already used in
   auth.mjs. Stored as "salt:hash", both hex. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string" || stored.indexOf(":") === -1) return false;
  const [salt, hash] = stored.split(":");
  try {
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    const a = Buffer.from(check, "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function publicView(s) {
  return { id: s.id, name: s.name, username: s.username, active: s.active !== false, createdAt: s.createdAt };
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[staff-accounts] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handle(req) {
  // Every operation here is admin-only — staff accounts are managed
  // by the shop owner, not by staff themselves.
  const session = verifySession(req);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const store = getStore(STORE_NAME);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const staff = await loadStaff(store);
    return Response.json({ ok: true, items: staff.map(publicView) });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const name = trimTo(body?.name, 80);
    const username = trimTo(body?.username, 40).toLowerCase();
    const password = typeof body?.password === "string" ? body.password : "";

    if (!name || !username || password.length < 4) {
      return Response.json(
        { ok: false, error: "missing_fields", message: "name, username, and a password (min 4 chars) are required." },
        { status: 400 }
      );
    }

    const staff = await loadStaff(store);
    if (staff.some((s) => s.username === username)) {
      return Response.json({ ok: false, error: "username_taken" }, { status: 409 });
    }

    const account = {
      id: nextId(staff),
      name,
      username,
      passwordHash: hashPassword(password),
      active: true,
      createdAt: new Date().toISOString()
    };
    staff.push(account);
    await saveStaff(store, staff);
    return Response.json({ ok: true, item: publicView(account) }, { status: 201 });
  }

  if (req.method === "PATCH") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const id = trimTo(body?.id, 20).toLowerCase();
    if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

    const staff = await loadStaff(store);
    const account = staff.find((s) => String(s.id).toLowerCase() === id);
    if (!account) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

    if (typeof body.name === "string" && body.name.trim()) account.name = trimTo(body.name, 80);
    if (typeof body.username === "string" && body.username.trim()) {
      const newUsername = trimTo(body.username, 40).toLowerCase();
      if (staff.some((s) => s.username === newUsername && s.id !== account.id)) {
        return Response.json({ ok: false, error: "username_taken" }, { status: 409 });
      }
      account.username = newUsername;
    }
    if (typeof body.password === "string" && body.password.length >= 4) {
      account.passwordHash = hashPassword(body.password);
    }
    if (typeof body.active === "boolean") account.active = body.active;

    await saveStaff(store, staff);
    return Response.json({ ok: true, item: publicView(account) });
  }

  if (req.method === "DELETE") {
    const id = (url.searchParams.get("id") || "").trim().toLowerCase();
    if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

    const staff = await loadStaff(store);
    const idx = staff.findIndex((s) => String(s.id).toLowerCase() === id);
    if (idx === -1) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

    const [removed] = staff.splice(idx, 1);
    await saveStaff(store, staff);
    return Response.json({ ok: true, removed: publicView(removed) });
  }

  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

// Exported so staff-login.mjs can verify credentials against the same
// store/hash format without duplicating the scrypt logic.
export { loadStaff, verifyPassword, STORE_NAME as STAFF_STORE_NAME, BLOB_KEY as STAFF_BLOB_KEY };

export const config = {
  path: "/api/staff-accounts",
  method: ["GET", "POST", "PATCH", "DELETE"]
};
