// controllers/wheelController.js
// Proxies TMDB's /discover/movie endpoint for the "movie wheel" feature.
// The TMDB API key is read from process.env and never exposed to the client.

const TMDB_BASE = "https://api.themoviedb.org/3/discover/movie";

// GET /api/movies/wheel?genreId=&providerId=&region=
async function wheel(req, res, next) {
  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      return res
        .status(500)
        .json({ ok: false, error: "TMDB_API_KEY is not configured on the server" });
    }

    const { genreId, providerId } = req.query;
    // TMDB provider filtering requires a watch_region; default to US, allow override.
    const region = req.query.region || "US";

    // Build TMDB query. Only include filters the client actually sent.
    const params = new URLSearchParams({
      api_key: apiKey,
      include_adult: "false",
      language: "en-US",
      sort_by: "popularity.desc",
    });
    if (genreId) params.set("with_genres", String(genreId));
    if (providerId) {
      params.set("with_watch_providers", String(providerId));
      params.set("watch_region", region);
    }

    const tmdbRes = await fetch(`${TMDB_BASE}?${params.toString()}`);

    if (!tmdbRes.ok) {
      // Surface TMDB's status without leaking the request URL (which holds the key).
      let detail = "";
      try {
        const body = await tmdbRes.json();
        detail = body.status_message || "";
      } catch (_) {
        /* non-JSON error body */
      }
      return res.status(tmdbRes.status).json({
        ok: false,
        error: `TMDB request failed${detail ? `: ${detail}` : ""}`,
      });
    }

    const data = await tmdbRes.json();
    return res.json({ ok: true, data: data.results || [] });
  } catch (err) {
    // Hand off to the central error handler in index.js.
    next(err);
  }
}

module.exports = { wheel };
