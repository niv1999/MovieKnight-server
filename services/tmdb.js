// TMDB v3 client. api key stays server-side.

const TMDB_BASE = "https://api.themoviedb.org/3";

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
    // log detail server-side only; never name the provider to the client
    if (detail) console.warn(`Upstream movie service ${res.status}: ${detail}`);
    const err = new Error("Movie service request failed");
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// clamp ?page to TMDB's valid 1-500 range
function clampPage(raw) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return 1;
  return Math.min(500, Math.max(1, n));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { tmdb, clampPage, randInt };
