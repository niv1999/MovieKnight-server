// index.js — MovieKnight TMDB proxy.
// A thin Express server that forwards a few read-only calls to the TMDB v3 API
// so the frontend never has to hold the API key. All TMDB calls happen here.

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// --- CORS: allow any origin, GET only, accept the Accept header ---
app.use(
  cors({
    origin: "*",
    methods: ["GET"],
    allowedHeaders: ["Accept"],
  })
);

// --- helper: call TMDB and return parsed JSON, throwing on a non-2xx ---
// `path` is a TMDB path like "/movie/popular"; `params` are extra query params.
async function tmdb(path, params = {}) {
  if (!TMDB_API_KEY) {
    const err = new Error("TMDB_API_KEY is not configured on the server");
    err.status = 500;
    throw err;
  }

  const url = new URL(TMDB_BASE + path);
  url.searchParams.set("api_key", TMDB_API_KEY);
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
    const err = new Error(`TMDB request failed${detail ? `: ${detail}` : ""}`);
    // Map TMDB's status straight through (the frontend treats non-2xx as failure).
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// small wrapper so each route stays a one-liner and errors hit the handler below
const route = (fn) => (req, res, next) => fn(req, res).catch(next);

// --- health check ---
app.get("/", (req, res) => {
  res.json({ ok: true, service: "movieknight-tmdb-proxy" });
});

// TMDB /discover/movie params the frontend may send. Names are TMDB-native and
// are forwarded straight through.
const DISCOVER_PARAMS = [
  "with_genres", // comma-separated genre IDs, e.g. "28,12"
  "with_watch_providers", // pipe-separated provider IDs, e.g. "8|9"
  "watch_region", // sent with with_watch_providers (US)
  "primary_release_date.gte", // YYYY-01-01
  "primary_release_date.lte", // YYYY-12-31
  "vote_average.gte", // 0–10
  "vote_count.gte", // optional floor; defaulted below when rating-filtering
  "sort_by", // optional catalog-wide sort (not sent by the frontend yet)
];

// Clamp a ?page value to a valid TMDB page: an integer in 1–500, default 1.
function clampPage(raw) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return 1;
  return Math.min(500, Math.max(1, n));
}

// 1. GET /movies — popular movies, or a filtered catalog when any discover param
//    is present. Both accept ?page (1–500) and return { movies: [...] }.
app.get(
  "/movies",
  route(async (req, res) => {
    const page = String(clampPage(req.query.page));

    const params = {};
    for (const key of DISCOVER_PARAMS) {
      const value = req.query[key];
      if (value !== undefined && value !== "") params[key] = value;
    }

    // No filters -> the original popular feed.
    if (Object.keys(params).length === 0) {
      const data = await tmdb("/movie/popular", { page });
      return res.json({ movies: data.results });
    }

    // Provider filtering needs a region; default to US if the client omitted it.
    if (params["with_watch_providers"] && !params["watch_region"]) {
      params["watch_region"] = "US";
    }
    // Keep rating filters from surfacing obscure titles with very few votes.
    if (params["vote_average.gte"] && params["vote_count.gte"] === undefined) {
      params["vote_count.gte"] = "50";
    }
    params["include_adult"] = "false";
    params["page"] = page;

    const data = await tmdb("/discover/movie", params);
    res.json({ movies: data.results });
  })
);

// 2. GET /movies/search?query=<text> — search by title. Empty query -> empty list.
app.get(
  "/movies/search",
  route(async (req, res) => {
    const query = (req.query.query || "").trim();
    if (!query) {
      return res.json({ movies: [] });
    }
    const data = await tmdb("/search/movie", { query, include_adult: "false" });
    res.json({ movies: data.results });
  })
);

// 3. GET /genres — movie genre list. TMDB returns { genres: [{ id, name }] }.
app.get(
  "/genres",
  route(async (req, res) => {
    const data = await tmdb("/genre/movie/list");
    res.json({ genres: data.genres });
  })
);

// 4. GET /providers — US watch/streaming providers. TMDB items include a large
//    per-country `display_priorities` map; trim to the fields the frontend uses
//    and keep `provider_id` (needed to filter via with_watch_providers).
app.get(
  "/providers",
  route(async (req, res) => {
    const data = await tmdb("/watch/providers/movie", { watch_region: "US" });
    const providers = (data.results || []).map((p) => ({
      provider_id: p.provider_id,
      provider_name: p.provider_name,
      logo_path: p.logo_path,
      display_priority: p.display_priority,
    }));
    res.json({ providers });
  })
);

// --- 404 ---
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- central error handler: surface TMDB/config status codes ---
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Server error" });
});

app.listen(PORT, () => {
  console.log(`🎬 TMDB proxy listening on http://localhost:${PORT}`);
});
