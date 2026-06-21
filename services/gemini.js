// services/gemini.js — thin Google Gemini client shared by the AI controllers.
// Mirrors services/tmdb.js: the API key stays server-side and every helper throws
// an Error with a mapped `.status` so the central error handler (index.js) emits
// the contract envelope { ok:false, error }.
//
// The whole point of this layer is to get STRUCTURED JSON back, never chat prose.
// We force that two ways at once:
//   1. generationConfig.responseMimeType = "application/json" — tells Gemini to
//      emit a JSON value, not markdown.
//   2. a strict schema instruction baked into every prompt (see the controllers).
// Even so, models occasionally wrap the JSON in ```json fences, so parseJsonArray
// strips those defensively before JSON.parse.

const { GoogleGenerativeAI } = require("@google/generative-ai");

// Free-tier friendly default; override with GEMINI_MODEL if you have access to a
// newer/faster model. gemini-2.5-flash is fast, cheap, and supports JSON mode.
// (The retired gemini-1.5-* models 404 on current API keys — verify a model is in
// `GET /v1beta/models` for your key before pinning it here.)
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

// Hard ceiling on a single generateContent call. The SDK won't abort the socket
// for us, so we race the request against a timer (withTimeout) and surface a 504
// to the client rather than letting a slow upstream hang the request.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20_000;

// Lazily constructed so the server still boots with an empty .env (per CLAUDE.md:
// the TMDB proxy must run without optional integrations configured). The key is
// only required the first time an AI endpoint is actually hit.
let client = null;
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("GEMINI_API_KEY is not configured on the server");
    err.status = 500;
    throw err;
  }
  if (!client) client = new GoogleGenerativeAI(apiKey);
  return client;
}

// Reject with a 504 if `promise` doesn't settle within `ms`. We don't cancel the
// underlying request (the SDK gives us no signal hook here) — we just stop waiting
// so the client gets a timely, well-shaped error instead of an open connection.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.status = 504;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Strip optional ```json … ``` fences and parse. Throws a 502 on anything that
// isn't a JSON array, so a hallucinated/garbled response becomes a clean upstream
// error rather than a downstream `undefined.map` crash.
function parseJsonArray(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "") // leading fence
    .replace(/\s*```$/i, "") // trailing fence
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    const err = new Error("AI response was not valid JSON");
    err.status = 502;
    throw err;
  }

  if (!Array.isArray(parsed)) {
    const err = new Error("AI response was not a JSON array");
    err.status = 502;
    throw err;
  }
  return parsed;
}

// Run one prompt in JSON mode and return the parsed array. `prompt` must itself
// describe the exact JSON shape (the controllers own those schema strings). All
// failure modes — missing key (500), timeout (504), bad JSON (502), upstream
// error (mapped/502) — arrive as Errors with a `.status`.
async function generateJsonArray(prompt, { temperature = 0.4 } = {}) {
  const model = getClient().getGenerativeModel({
    model: MODEL,
    generationConfig: {
      // Force structured output: the model returns a JSON value, not chat prose.
      responseMimeType: "application/json",
      // A little creativity for recommendations, still grounded. Callers that want
      // fresh picks on repeat calls (e.g. "Let AI Choose" → Try Again) raise this.
      temperature,
      // gemini-2.5-* are "thinking" models: left on, a 50-title search spends its
      // whole budget reasoning and blows past GEMINI_TIMEOUT_MS. Our tasks are
      // ranking/extraction, not reasoning, so we disable thinking — a 50-result
      // search drops from >20s to ~6s. (Ignored by non-thinking models.)
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let result;
  try {
    result = await withTimeout(
      model.generateContent(prompt),
      GEMINI_TIMEOUT_MS,
      "Gemini request"
    );
  } catch (err) {
    if (err.status) throw err; // our own timeout/config error — already shaped
    // SDK/network/quota failure — treat as a bad upstream gateway.
    const wrapped = new Error(`Gemini request failed: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  return parseJsonArray(result.response.text());
}

module.exports = { generateJsonArray, MODEL };
