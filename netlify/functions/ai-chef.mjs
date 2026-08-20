/* ═══════════════════════════════════════════════════════════════════
   NP MART — AI CHEF SERVER-SIDE PROXY
   ───────────────────────────────────────────────────────────────────
   Keeps API keys OFF the public page. The browser calls /api/ai-chef
   and never sees a key, so leaked-key scanners can't auto-revoke them.

   Tries up to FOUR independent AI providers, in this order, falling
   through to the next whenever one is unconfigured, rejected, or
   times out: OpenRouter -> Groq -> Mistral -> Gemini. Set as many or
   as few as you have keys for — at least one is required.

   REQUIRED Netlify environment variables (Site config > Environment
   variables, scope: Functions). Variables set inside netlify.toml are
   NOT available to functions — use the Netlify UI, not this file.

     OPENROUTER_API_KEY   (optional)  e.g. sk-or-v1-...
     GROQ_API_KEY         (optional)  e.g. gsk_...
     MISTRAL_API_KEY      (optional)  plain alphanumeric string
     GEMINI_API_KEY       (optional)  e.g. AQ.Ab... (new format) or
                                       AIza... (legacy format)
     GEMINI_API_KEY_2     (optional)  a second Gemini key, tried after
                                       the first one if it fails — handy
                                       if you have keys on two separate
                                       Google accounts/projects.

   NOTE: env values are baked in at deploy time. After adding or
   changing a variable you MUST trigger a new deploy.

   DIAGNOSTICS: GET /api/ai-chef?diag=1 (must be logged into the admin
   panel — same cookie as everything else). Sends one cheap, minimal
   message to every configured provider/key and reports back the raw
   status/detail for each — this is how you tell "key missing" apart
   from "key rejected" apart from "provider having issues" without
   digging through browser DevTools. The admin panel's "Test AI Keys"
   button calls this. See admin/index.html.
   ═══════════════════════════════════════════════════════════════════ */

import { verifySession } from "./_lib/auth.mjs";

/* Overall budget. Netlify's synchronous function limit is actually 60s
   (confirmed against current docs — not the 10s/26s figures floating
   around older forum posts), but the browser's own fetch in index.html
   gives up after 22s (see AI_CHEF_TIMEOUT_MS in index.html) so there's
   no point budgeting past that. Leave a few seconds of margin under
   it for function cold-start + network overhead. */
const TOTAL_BUDGET_MS = 18000;
const PER_ATTEMPT_MS = 5000;

/* OpenRouter free-tier slugs, ordered by preference. Kept to models
   that have been stable/well-established for a long time — if the
   free roster changes, check https://openrouter.ai/models (filter:
   "free") and update this list.

   NOTE: a brand-new OpenRouter account's data-collection policy
   defaults to blocking every :free model with a 404
   ("no_endpoints"/"privacy_restricted" — those providers require
   permission to log/train on the prompt). We no longer rely on a
   dashboard toggle to fix this (it wasn't findable in the current UI
   when we checked) — instead callOpenRouter() below sends
   `provider: { data_collection: "allow" }` in every request body,
   which overrides the account default per-request. See
   https://openrouter.ai/docs/features/provider-routing */
const OPENROUTER_MODELS = [
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-26b-a4b-it:free",
  "openrouter/free"
];

/* Groq (api.groq.com) — very fast inference, generous free tier. */
const GROQ_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b"
];

/* Mistral AI "La Plateforme" (api.mistral.ai). The "-latest" aliases
   are safer to hardcode than dated snapshot IDs (e.g. mistral-small-
   2603) since Mistral moves the alias forward for you. */
const MISTRAL_MODELS = [
  "ministral-8b-latest",
  "mistral-small-latest",
  "open-mistral-nemo"
];

/* Gemini models on the generateContent endpoint. */
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash"
];

function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

async function callOpenAiCompatible(url, apiKey, prompt, model, maxTokens, extraHeaders, tokensField, extraBody) {
  const { signal, clear } = timeoutSignal(PER_ATTEMPT_MS);
  try {
    const body = Object.assign(
      {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        ...(maxTokens ? {} : { response_format: { type: "json_object" } })
      },
      extraBody || {}
    );
    body[tokensField || "max_tokens"] = maxTokens || 1200;

    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: Object.assign({ "Content-Type": "application/json", "Authorization": "Bearer " + apiKey }, extraHeaders || {}),
      body: JSON.stringify(body)
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, detail: bodyText.slice(0, 400) };
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { ok: false, status: res.status, detail: "Non-JSON body from " + url };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      return { ok: false, status: res.status, detail: "Empty content in response" };
    }
    return { ok: true, text };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { ok: false, status: isAbort ? 504 : 0, detail: isAbort ? "Timed out" : String(err?.message || err) };
  } finally {
    clear();
  }
}

function callOpenRouter(apiKey, prompt, model, maxTokens, siteUrl) {
  return callOpenAiCompatible(
    "https://openrouter.ai/api/v1/chat/completions",
    apiKey, prompt, model, maxTokens,
    { "HTTP-Referer": siteUrl || "https://npmart.netlify.app", "X-Title": "NP Mart AI Chef" },
    "max_tokens",
    // Fixes the "404 no_endpoints / privacy_restricted" error that a
    // fresh OpenRouter account gets on every single :free model: those
    // providers require permission to log/train on the prompt, and a
    // new account's data-collection policy defaults to blocking that
    // account-wide. This overrides it per-request in code instead of
    // requiring a dashboard setting (which may not even be visible in
    // the current OpenRouter UI — confirmed by testing). See
    // https://openrouter.ai/docs/features/provider-routing
    { provider: { data_collection: "allow" } }
  );
}

function callGroq(apiKey, prompt, model, maxTokens) {
  return callOpenAiCompatible(
    "https://api.groq.com/openai/v1/chat/completions",
    apiKey, prompt, model, maxTokens,
    {},
    "max_completion_tokens"
  );
}

function callMistral(apiKey, prompt, model, maxTokens) {
  return callOpenAiCompatible(
    "https://api.mistral.ai/v1/chat/completions",
    apiKey, prompt, model, maxTokens,
    {},
    "max_tokens"
  );
}

async function callGemini(apiKey, prompt, model, maxTokens) {
  const { signal, clear } = timeoutSignal(PER_ATTEMPT_MS);
  try {
    // AQ.-format keys (Google's newer "Authentication Key" format,
    // rolling out through 2026 to replace AIza... keys) only work on
    // this native REST endpoint with the x-goog-api-key header — NOT
    // as a `?key=` query param and NOT on the OpenAI-compatibility
    // shim. Legacy AIza... keys work fine here too, so this one code
    // path covers both key formats.
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent";

    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens || 1200,
          // Forces clean JSON so the client never has to regex it out
          // of a Markdown code fence. Diagnostics pass a tiny maxTokens
          // and skip this — plain text is fine and one less thing that
          // can go wrong on a 5-token test message.
          ...(maxTokens ? {} : { responseMimeType: "application/json" })
        }
      })
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, detail: bodyText.slice(0, 400) };
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { ok: false, status: res.status, detail: "Non-JSON body from Gemini" };
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map(p => p?.text || "").join("").trim() : "";
    if (!text) {
      const blocked = data?.promptFeedback?.blockReason
        || data?.candidates?.[0]?.finishReason
        || "Empty content in Gemini response";
      return { ok: false, status: res.status, detail: String(blocked) };
    }
    return { ok: true, text };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { ok: false, status: isAbort ? 504 : 0, detail: isAbort ? "Timed out" : String(err?.message || err) };
  } finally {
    clear();
  }
}

/* Every provider defined once here — the chat handler and the
   diagnostics endpoint both walk this same list, so there's exactly
   one place that knows the provider order and which env vars back
   each one. `keys()` returns an array so Gemini can have two. */
function buildProviders(siteUrl) {
  return [
    {
      id: "gemini",
      keys: () => [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean),
      models: GEMINI_MODELS,
      call: callGemini,
      breakOn: (status) => status === 400 || status === 401 || status === 403
    },
    {
      id: "mistral",
      keys: () => [process.env.MISTRAL_API_KEY].filter(Boolean),
      models: MISTRAL_MODELS,
      call: callMistral,
      breakOn: (status) => status === 401 || status === 403
    },
    {
      id: "groq",
      keys: () => [process.env.GROQ_API_KEY].filter(Boolean),
      models: GROQ_MODELS,
      call: callGroq,
      breakOn: (status) => status === 401 || status === 403
    },
    {
      id: "openrouter",
      keys: () => [process.env.OPENROUTER_API_KEY].filter(Boolean),
      models: OPENROUTER_MODELS,
      call: (key, prompt, model, maxTokens) => callOpenRouter(key, prompt, model, maxTokens, siteUrl),
      breakOn: (status) => status === 401 || status === 403
    }
  ];
}

/* One cheap, minimal call per configured provider/key — used by the
   admin panel's "Test AI Keys" button so a key problem shows up as a
   plain pass/fail instead of requiring DevTools. Only the first model
   in each provider's list is tested (that's enough to prove the key
   itself works; model-specific issues show up in real usage anyway). */
async function runDiagnostics(siteUrl) {
  const providers = buildProviders(siteUrl);
  const results = [];

  for (const provider of providers) {
    const keys = provider.keys();
    if (!keys.length) {
      results.push({ provider: provider.id, label: labelFor(provider.id), configured: false, message: "No API key set for this provider." });
      continue;
    }
    for (let i = 0; i < keys.length; i++) {
      const model = provider.models[0];
      const r = await provider.call(keys[i], "Reply with the single word: ok", model, 150);
      const label = keys.length > 1 ? labelFor(provider.id) + " (key " + (i + 1) + ")" : labelFor(provider.id);
      results.push(Object.assign({ provider: provider.id, label, configured: true, model }, r));
    }
  }

  return { ok: true, results };
}

function labelFor(id) {
  return { openrouter: "OpenRouter", groq: "Groq", mistral: "Mistral", gemini: "Gemini" }[id] || id;
}

export default async (req) => {
  try {
    const url = new URL(req.url);

    // ─── Diagnostics: GET /api/ai-chef?diag=1, admin-only ───────────
    if (req.method === "GET") {
      if (url.searchParams.get("diag") !== "1") {
        return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
      }
      const session = verifySession(req);
      if (!session) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const result = await runDiagnostics(process.env.URL);
      return Response.json(result);
    }

    return await handleChat(req);
  } catch (err) {
    // Never let this fall through to a bare, bodyless 502 — always
    // answer with JSON that says exactly what broke, distinguishable
    // in the Network tab from the intentional all_providers_failed 502.
    console.error("[ai-chef] unhandled error", err);
    return Response.json(
      { ok: false, error: "internal_error", message: String(err?.message || err) },
      { status: 500 }
    );
  }
};

async function handleChat(req) {
  const startedAt = Date.now();
  const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_request", message: "Body must be JSON." }, { status: 400 });
  }

  const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return Response.json({ ok: false, error: "bad_request", message: "Missing 'prompt'." }, { status: 400 });
  }
  if (prompt.length > 12000) {
    return Response.json({ ok: false, error: "bad_request", message: "Prompt too long." }, { status: 413 });
  }

  const providers = buildProviders(process.env.URL);
  const configured = providers.filter((p) => p.keys().length);

  if (!configured.length) {
    return Response.json({
      ok: false,
      error: "not_configured",
      message: "No AI provider key is set. Add at least one of OPENROUTER_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY in Netlify (scope: Functions), then redeploy."
    }, { status: 503 });
  }

  // Every failure is recorded so the real reason is visible in the
  // Netlify function log and in the JSON response.
  const attempts = [];

  outer:
  for (const provider of configured) {
    const keys = provider.keys();
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki];
      for (const model of provider.models) {
        if (budgetLeft() < 2000) break outer;
        const r = await provider.call(key, prompt, model);
        if (r.ok) {
          return Response.json({ ok: true, text: r.text, provider: provider.id, model, attempts });
        }
        const attempt = { provider: provider.id, model, status: r.status, detail: r.detail };
        if (keys.length > 1) attempt.key = ki + 1;
        attempts.push(attempt);
        // A bad key fails identically on every model for that key —
        // stop burning budget proving it, move on to the next key (if
        // any) or the next provider.
        if (provider.breakOn(r.status)) break;
      }
    }
  }

  console.error("[ai-chef] all providers failed", JSON.stringify(attempts));

  return Response.json({
    ok: false,
    error: "all_providers_failed",
    message: "Every configured AI provider rejected the request.",
    attempts
  }, { status: 502 });
}

export const config = {
  path: "/api/ai-chef",
  method: ["GET", "POST"]
};
