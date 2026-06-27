// services/tmdb.js — thin TMDB v3 client shared by every TMDB-backed controller.
// Injects the server-side API key so it never reaches the browser, and returns
// parsed JSON (throwing on a non-2xx with the upstream status mapped through).

const TMDB_BASE = "https://api.themoviedb.org/3";

// Call TMDB and return parsed JSON. `path` is a TMDB path like "/movie/popular";
// `params` are extra query params. Throws an Error with `.status` on a non-2xx.
async function tmdb(path, params = {}) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    const err = new Error("Movie service is not configured on the server");
    err.status = 500;
    throw err;
  }

  const url = new URL(TMDB_BASE + path);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("language", "en-US");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.status_message || "";
    } catch (_) {
      /* non-JSON error body */
    }
    // Log the upstream detail server-side only; never surface the provider name
    // (or raw technical detail) to the client.
    if (detail) console.warn(`Upstream movie service ${res.status}: ${detail}`);
    const err = new Error("Movie service request failed");
    // Map the upstream status straight through (the frontend treats non-2xx as failure).
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// Clamp a ?page value to a valid TMDB page: an integer in 1–500, default 1.
function clampPage(raw) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return 1;
  return Math.min(500, Math.max(1, n));
}

// Inclusive random integer in [min, max].
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { tmdb, clampPage, randInt };
