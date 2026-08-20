# NP Mart Admin Panel — what changed and how to deploy it

## What was built (Step 1 of the backend work)

A password-protected admin panel at `/admin` where you can search products,
edit price/stock/name/unit inline, add new products, and delete products —
without touching `index.html` by hand.

**Important — this step does NOT change what customers see yet.** The admin
panel reads/writes a *new* copy of your catalog stored in Netlify Blobs. Your
live storefront (`index.html`) still uses its own built-in product list, like
before. Wiring the storefront to actually show your admin edits live is the
next step, once you've tried this out and confirmed it works the way you
want.

## Files added / changed

```
netlify/functions/ai-chef.mjs        (moved here from the repo root — same file, unchanged)
netlify/functions/products.mjs       (new — product API: list/search/edit/add/delete)
netlify/functions/admin-login.mjs    (new — password check, issues a session cookie)
netlify/functions/admin-logout.mjs   (new)
netlify/functions/admin-me.mjs       (new — "am I logged in?" check)
netlify/functions/_lib/auth.mjs      (new — shared session/cookie signing logic)
netlify/functions/data/products-seed.json  (new — your current ~15,808 products,
                                              extracted from index.html, used to
                                              seed the store the first time it runs)
admin/index.html                     (new — the admin panel page itself)
netlify.toml                         (updated — added routes for the new functions)
package.json                         (new — declares the @netlify/blobs dependency)
.gitignore                           (updated — also ignores node_modules/)
.env                                 (updated — added ADMIN_PASSWORD / ADMIN_SESSION_SECRET
                                      placeholders; your existing AI keys are untouched)
```

**Action needed:** if your repo currently has `ai-chef.mjs` sitting at the
root, delete that copy — it's been moved to `netlify/functions/ai-chef.mjs`
so it deploys alongside the new functions.

## Deploy steps

1. **Copy these files into your GitHub repo**, keeping the folder structure
   above, replacing `netlify.toml`, `.gitignore`, and `.env` with the updated
   versions here.

2. **Set the two new environment variables in Netlify** — Site configuration
   → Environment variables → Add a variable (scope: Functions):
   - `ADMIN_PASSWORD` — the password you'll type in to log into `/admin`.
     Pick something only you know; don't reuse your email password.
   - `ADMIN_SESSION_SECRET` — a long random string, never shown to anyone.
     Generate one with `openssl rand -hex 32` in any terminal, or ask me to
     generate one for you.
   (Your existing `OPENROUTER_API_KEY` / `GEMINI_API_KEY` stay as they are.)

3. **Commit and push** — Netlify will redeploy automatically. Because
   `package.json` now lists `@netlify/blobs`, Netlify's build will install it
   automatically; you don't need to run anything locally.

4. **Visit `https://<your-site>.netlify.app/admin`**, log in with the
   password you set, and you should see your full product list, searchable,
   with editable price/stock. First load seeds the store from your current
   catalog automatically — nothing to run by hand.

## What I verified before handing this off

I wrote a small offline test harness that exercises every endpoint (using a
mock of Netlify Blobs, since that only runs for real on Netlify's servers)
and confirmed:
- product search and pagination work correctly against all ~15,808 products
- editing price/stock/name/unit saves and is immediately reflected on
  re-fetch
- adding and deleting products works and generates a valid unique ID
- every write endpoint correctly rejects requests with no session, a wrong
  password, or a tampered session cookie (401 in all three cases)
- logging out clears the session so a re-used cookie no longer works

I could not test the *real* Netlify Blobs connection or an actual browser
login flow from here (both only work once this is deployed on Netlify), so
give it a real run after deploying and tell me if anything looks off —
especially the first-load seeding step, since that only happens once per
site and I can't rehearse it outside Netlify's infrastructure.

## About the Hostinger move (noted for later)

Everything above uses `@netlify/blobs`, which is Netlify-only. When you move
to Hostinger shared hosting, this data layer (`products.mjs` + Blobs) will
need to be rebuilt against whatever Hostinger gives you (typically PHP +
MySQL) — that's the "rebuild later" tradeoff we agreed on to move fast now.
The admin UI (`admin/index.html`) itself is plain HTML/JS and can mostly be
reused; only the fetch calls' backend would change.

## Next step (when you're ready)

Once you've tried the admin panel and I know it does what you want, the
next piece is wiring `index.html`'s storefront to actually fetch the live
catalog from `/api/products` instead of its built-in list — that's the part
that makes your admin edits show up for real customers. It's a careful
change to a very large file, so it'll get its own pass rather than being
bundled into this one.
