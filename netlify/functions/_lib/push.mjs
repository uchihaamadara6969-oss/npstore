/* ═══════════════════════════════════════════════════════════════════
   NP MART — FIREBASE CLOUD MESSAGING (FCM) PUSH HELPER
   ───────────────────────────────────────────────────────────────────
   Sends push alerts to the staff Android app via FCM's current HTTP
   v1 API. FCM itself is unconditionally free with no usage cap — this
   file just implements the (slightly fiddly) auth handshake Google
   requires: a service-account JSON key is used to sign a short-lived
   JWT, which is exchanged for an OAuth access token, which is then
   used to call the actual send endpoint. No npm SDK needed — it's
   three plain fetch calls' worth of plumbing, done here with Node's
   built-in crypto so this file has zero new dependencies, matching
   the rest of this codebase's style (see ai-chef.mjs).

   Messages are sent to a TOPIC ("npmart-staff-orders"), not to
   individual device tokens — the Android app subscribes itself to
   that topic on login (via the Firebase SDK, client-side), so this
   backend never has to store/manage device tokens at all. One send
   here reaches every logged-in staff phone at once.

   Every message is a DATA message (no "notification" block) so the
   Android app's own code decides how to show it — a full-screen,
   continuously-vibrating "new order" alert, not a plain notification
   tray item. See the Android app's FCM service for that logic.

   REQUIRED Netlify environment variables (Site config > Environment
   variables, scope: Functions):
     FIREBASE_SERVICE_ACCOUNT_JSON   the ENTIRE contents of the service
                                      account JSON key file downloaded
                                      from Firebase Console > Project
                                      Settings > Service Accounts >
                                      Generate new private key. Paste
                                      the whole JSON as one env var
                                      value (it's already one line of
                                      valid JSON when copied from the
                                      downloaded file).

   Every call is best-effort: a push failure never blocks or fails the
   order-creation/accept/status-update request it's attached to — it's
   logged and swallowed, since the order itself is already safely
   saved either way (the staff app also polls on open as a fallback,
   so a missed push isn't a lost order, just a slightly late alert).
   ═══════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const STAFF_TOPIC = "npmart-staff-orders";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// In-memory cache within one warm function instance — access tokens
// are valid ~1hr, no need to re-mint one on every single push.
let cachedToken = null; // { accessToken, expiresAt }

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[push] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:", err?.message);
    return null;
  }
}

async function getAccessToken(serviceAccount) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.accessToken;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600
  };

  const unsigned = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), serviceAccount.private_key).toString("base64url");
  const jwt = unsigned + "." + signature;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error("OAuth token exchange failed: " + res.status + " " + bodyText.slice(0, 300));
  }

  const data = JSON.parse(bodyText);
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3500) * 1000 };
  return cachedToken.accessToken;
}

/**
 * Sends a high-priority data-only FCM message to every staff device
 * subscribed to the staff topic. `data` values must all be strings
 * (FCM data payload requirement) — pass primitives, not nested objects.
 * Never throws — logs and returns { ok:false } on any failure so
 * callers can fire-and-forget this safely.
 */
export async function sendStaffPush(data) {
  const serviceAccount = getServiceAccount();
  if (!serviceAccount) {
    console.warn("[push] FIREBASE_SERVICE_ACCOUNT_JSON not set — skipping push (order was still saved normally).");
    return { ok: false, error: "not_configured" };
  }

  try {
    const accessToken = await getAccessToken(serviceAccount);

    const stringData = {};
    for (const [k, v] of Object.entries(data || {})) {
      stringData[k] = String(v);
    }

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + accessToken
        },
        body: JSON.stringify({
          message: {
            topic: STAFF_TOPIC,
            data: stringData,
            android: {
              priority: "high",
              // TTL 0 = deliver now or not at all; a stale "new order"
              // alert after connectivity comes back would be confusing
              // since the order's real status may have moved on by then.
              ttl: "0s"
            }
          }
        })
      }
    );

    const bodyText = await res.text();
    if (!res.ok) {
      console.error("[push] FCM send failed:", res.status, bodyText.slice(0, 300));
      return { ok: false, error: "fcm_error", status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.error("[push] send threw:", err?.message || err);
    return { ok: false, error: "exception", message: String(err?.message || err) };
  }
}

export { STAFF_TOPIC };
