// Gemini client for structured JSON output. api key stays server-side.

const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20_000;

// lazy so the server still boots with an empty .env; key only needed on first AI hit
let client = null;
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("AI service is not configured on the server");
    err.status = 500;
    throw err;
  }
  if (!client) client = new GoogleGenerativeAI(apiKey);
  return client;
}

// reject with 504 if promise doesn't settle in ms. can't cancel the request (no
// signal hook), just stop waiting.
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

// strip optional ```json fences then parse; throws 502 on anything that isn't a JSON array
function parseJsonArray(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
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

// run one prompt in JSON mode, return the parsed array. failures arrive as Errors
// with a .status (500 missing key / 504 timeout / 502 bad-json or upstream).
async function generateJsonArray(prompt, { temperature = 0.4, schema = null } = {}) {
  const generationConfig = {
    responseMimeType: "application/json",
    temperature,
    // disable "thinking" so a large request can't burn its budget reasoning and time out
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (schema) generationConfig.responseSchema = schema;

  const model = getClient().getGenerativeModel({ model: MODEL, generationConfig });

  let result;
  try {
    result = await withTimeout(
      model.generateContent(prompt),
      GEMINI_TIMEOUT_MS,
      "AI request"
    );
  } catch (err) {
    if (err.status) throw err; // already shaped
    // log real detail server-side only; surface a generic error so nothing leaks
    console.warn("Upstream AI service error:", err.message);
    const wrapped = new Error("AI service request failed");
    wrapped.status = 502;
    throw wrapped;
  }

  return parseJsonArray(result.response.text());
}

module.exports = { generateJsonArray };
