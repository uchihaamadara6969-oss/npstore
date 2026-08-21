/* ═══════════════════════════════════════════════════════════════════
   NP MART — PRODUCT PHOTO API
   ───────────────────────────────────────────────────────────────────
   Stores one photo per product in its own Netlify Blobs store
   (separate from the catalog store, since images are much bigger than
   product data and there's no reason to load them together). The
   image is stored as the exact data: URL the browser produced when
   reading the uploaded file — that keeps this endpoint simple (plain
   string get/set, no binary/metadata APIs to get right) at the cost
   of ~33% extra storage from base64 encoding, which is a fine trade
   for product photos.

   GET    /api/product-image?id=a12345   public. Returns the raw image
            bytes with the correct Content-Type — usable directly as
            an <img src>. 404 if no photo has been uploaded yet.
   POST   /api/product-image             admin-only. Body:
            { "id": "a12345", "dataUrl": "data:image/jpeg;base64,..." }
            Overwrites any existing photo for that product. 4MB cap.
   DELETE /api/product-image?id=a12345   admin-only. Removes the photo.
   ═══════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { requireAdminOrDev } from "./_lib/auth.mjs";

const STORE_NAME = "npmart-images";
const MAX_BYTES = 4 * 1024 * 1024; // 4MB raw file cap

function keyFor(id) {
  return String(id || "").trim().toLowerCase();
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec(dataUrl || "");
  if (!m) return null;
  return { contentType: m[1], base64: m[2] };
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("[product-image] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handle(req) {
  const store = getStore(STORE_NAME);
  const url = new URL(req.url);
  const id = keyFor(url.searchParams.get("id"));

  // ─── Public read ────────────────────────────────────────────────
  if (req.method === "GET") {
    if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

    const dataUrl = await store.get(id);
    if (!dataUrl) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return Response.json({ ok: false, error: "corrupt_image" }, { status: 500 });

    const bytes = Buffer.from(parsed.base64, "base64");
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": parsed.contentType,
        // Short-ish cache: long enough to help perf, short enough that
        // a replaced photo shows up again without the admin needing to
        // think about cache-busting.
        "Cache-Control": "public, max-age=3600"
      }
    });
  }

  // ─── Everything below writes data — admin or developer session ───
  const auth = await requireAdminOrDev(req);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const pid = keyFor(body?.id);
    if (!pid) return Response.json({ ok: false, error: "id_required" }, { status: 400 });

    const parsed = parseDataUrl(typeof body?.dataUrl === "string" ? body.dataUrl : "");
    if (!parsed) {
      return Response.json(
        { ok: false, error: "invalid_image", message: "Expected a data: URL (read the file as base64 in the browser first)." },
        { status: 400 }
      );
    }
    if (!/^image\//.test(parsed.contentType)) {
      return Response.json({ ok: false, error: "invalid_type", message: "File must be an image." }, { status: 400 });
    }

    const approxBytes = Math.ceil((parsed.base64.length * 3) / 4);
    if (approxBytes > MAX_BYTES) {
      return Response.json({ ok: false, error: "too_large", message: "Image must be under 4MB." }, { status: 413 });
    }

    await store.set(pid, `data:${parsed.contentType};base64,${parsed.base64}`);
    return Response.json({ ok: true, id: pid });
  }

  if (req.method === "DELETE") {
    if (!id) return Response.json({ ok: false, error: "id_required" }, { status: 400 });
    await store.delete(id);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export const config = {
  path: "/api/product-image",
  method: ["GET", "POST", "DELETE"]
};
