// controllers/movieController.js — movie endpoints backed by the TMDB proxy.
// All routes return the contract envelope { ok:true, data } / { ok:false, error }.
// Handlers are plain async (req, res); the routes/ layer wraps them with route().

const { tmdb, clampPage, randInt } = require("../services/tmdb");
const movieCache = require("../services/movieCache");

// Pick one truly random (often obscure), non-adult movie.
//    TMDB has no native random endpoint, so we brute-force it: pick a random ID,
//    fetch /movie/{id}, and retry on a 404 (dead ID) or an adult title. To avoid
//    hanging when we keep hitting dead/adult IDs, we cap attempts and fall back to
//    a random title from the popular feed (pages 1–500).
//    Returns { movie, fallback } — fallback is true when the loop maxed out.
const RANDOM_MAX_ID = 1_200_000; // rough upper bound of TMDB movie IDs
const RANDOM_MAX_ATTEMPTS = 20; // fail-safe so the loop can't hang the server
async function pickRandomMovie() {
  for (let attempt = 0; attempt < RANDOM_MAX_ATTEMPTS; attempt++) {
    const id = randInt(1, RANDOM_MAX_ID);

    let movie;
    try {
      movie = await tmdb(`/movie/${id}`);
    } catch (err) {
      if (err.status === 404) continue; // dead ID — try another
      throw err; // real failure (auth, rate-limit, network) — surface it
    }

    if (movie.adult === false) {
      return { movie, fallback: false };
    }
    // adult title — discard and keep looking
  }

  // Fail-safe: the loop maxed out, so return a reliable popular title instead.
  const popular = await tmdb("/movie/popular", { page: randInt(1, 500) });
  const results = popular.results || [];
  if (results.length === 0) {
    const err = new Error("No fallback movie available");
    err.status = 502;
    throw err;
  }
  return { movie: results[randInt(0, results.length - 1)], fallback: true };
}

// Server-side sort comparators for /api/movies/search. Keys are the allowable
// `sort` values; default is "popularity".
const DEFAULT_SORT = "popularity";
const releaseYear = (m) => {
  const y = parseInt(String(m.release_date || "").slice(0, 4), 10);
  return Number.isFinite(y) ? y : null; // null = undated
};
// Year comparator that keeps undated titles at the bottom in both directions.
const byYear = (dir) => (a, b) => {
  const ya = releaseYear(a);
  const yb = releaseYear(b);
  if (ya === null && yb === null) return 0;
  if (ya === null) return 1; // undated always sinks
  if (yb === null) return -1;
  return dir === "asc" ? ya - yb : yb - ya;
};
const SORTERS = {
  popularity: (a, b) => (b.popularity || 0) - (a.popularity || 0),
  rating_desc: (a, b) => (b.vote_average || 0) - (a.vote_average || 0),
  rating_asc: (a, b) => (a.vote_average || 0) - (b.vote_average || 0),
  title_asc: (a, b) => String(a.title || "").localeCompare(String(b.title || "")),
  title_desc: (a, b) => String(b.title || "").localeCompare(String(a.title || "")),
  year_desc: byYear("desc"),
  year_asc: byYear("asc"),
};

// Our `sort` values -> TMDB /discover `sort_by`. TMDB has no title sort, so
// title_* maps to original_title.*; year_* maps to primary_release_date.*.
// (/search/movie ignores sort_by entirely; the text path sorts within the page.)
const SORT_BY = {
  popularity: "popularity.desc",
  rating_desc: "vote_average.desc",
  rating_asc: "vote_average.asc",
  title_asc: "original_title.asc",
  title_desc: "original_title.desc",
  year_desc: "primary_release_date.desc",
  year_asc: "primary_release_date.asc",
};

// Default vote floor for rating sorts so a handful of single-vote 10.0 titles
// don't dominate. Only applied when the caller didn't set their own minVotes.
const RATING_SORT_VOTE_FLOOR = 50;

// Free-text search via TMDB /search/movie. That endpoint can't honor discover
// filters or sort_by, so we re-apply the filters server-side and sort within the
// page. `page` is forwarded 1:1 to TMDB, so pages stay full as the user scrolls
// (a filter may trim a page, but nothing is sliced or capped to a fixed pool).
const searchByText = async (q, page, f) => {
  const data = await tmdb("/search/movie", { query: q, include_adult: "false", page });
  let results = data.results || [];
  if (f.genre !== null) {
    results = results.filter((m) => (m.genre_ids || []).includes(f.genre));
  }
  if (f.yearFrom !== null || f.yearTo !== null) {
    results = results.filter((m) => {
      const y = releaseYear(m);
      if (y === null) return false; // undated excluded when a year range is set
      if (f.yearFrom !== null && y < f.yearFrom) return false;
      if (f.yearTo !== null && y > f.yearTo) return false;
      return true;
    });
  }
  if (f.minRating !== null) results = results.filter((m) => (m.vote_average || 0) >= f.minRating);
  if (f.minVotes !== null) results = results.filter((m) => (m.vote_count || 0) >= f.minVotes);
  if (f.language !== null) results = results.filter((m) => m.original_language === f.language);
  results.sort(SORTERS[f.sort]); // /search/movie can't sort_by — order within the page
  return results;
};

// ===========================================================================
// /api contract handlers — envelope { ok:true, data } / { ok:false, error }.
// ===========================================================================

// GET /api/movies/search — filtered/sorted movie feed with continuous pagination.
// Params: q, genre, yearFrom, yearTo, minRating, minVotes, language, with_cast,
// with_crew, sort (default popularity), page. Empty q -> the discover catalog feed.
//
// `page` maps 1:1 to the underlying TMDB page (TMDB serves up to page 500) and
// every filter is pushed into TMDB as a native /discover param, so result sets
// don't shrink as you scroll — we return an empty array only when TMDB itself
// runs out of pages. The free-text path (q without a person filter) must use
// /search/movie, which ignores those params, so it re-applies them server-side.
async function search(req, res) {
  const q = String(req.query.q || "").trim();
  const sort = SORTERS[req.query.sort] ? req.query.sort : DEFAULT_SORT;
  const page = clampPage(req.query.page);
  const genre = req.query.genre ? Number(req.query.genre) : null;
  const yearFrom = req.query.yearFrom ? Number(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo ? Number(req.query.yearTo) : null;
  const minRating = req.query.minRating ? Number(req.query.minRating) : null;
  const minVotes = req.query.minVotes ? Number(req.query.minVotes) : null;
  const language = req.query.language ? String(req.query.language).trim() : null;
  const withCast = req.query.with_cast ? String(req.query.with_cast) : null;
  const withCrew = req.query.with_crew ? String(req.query.with_crew) : null;

  // Fingerprint the request for the feed cache. genre is kept as its RAW query
  // string (it may be a comma-joined multi-id like "28,12"); the rest are the
  // normalized single values. Two requests with the same fingerprint share a
  // cached page; anything that changes the results changes the key.
  // NOTE: any NEW filter added to the TMDB params below MUST also be added here,
  // or two different queries would collide on one cached (wrong) page.
  const keyParams = {
    q,
    sort,
    page,
    genre: req.query.genre ? String(req.query.genre) : null,
    yearFrom,
    yearTo,
    minRating,
    minVotes,
    language,
    with_cast: withCast,
    with_crew: withCrew,
  };

  // The real TMDB fetch — only runs on a cache miss (or when Mongo is unavailable).
  const fetchFromTmdb = async () => {
    // Free-text search (no person filter): /search/movie, page forwarded 1:1.
    if (q && !withCast && !withCrew) {
      return searchByText(q, page, {
        genre, yearFrom, yearTo, minRating, minVotes, language, sort,
      });
    }

    // Everything else uses /discover with every filter as a native param and the
    // page forwarded straight through.
    const params = {
      include_adult: "false",
      sort_by: SORT_BY[sort],
      page,
    };
    if (genre !== null) params.with_genres = genre;
    if (yearFrom !== null) params["primary_release_date.gte"] = `${yearFrom}-01-01`;
    if (yearTo !== null) params["primary_release_date.lte"] = `${yearTo}-12-31`;
    if (minRating !== null) params["vote_average.gte"] = minRating;
    if (minVotes !== null) params["vote_count.gte"] = minVotes;
    else if (minRating !== null || sort === "rating_desc" || sort === "rating_asc") {
      params["vote_count.gte"] = RATING_SORT_VOTE_FLOOR;
    }
    if (language !== null) params.with_original_language = language;
    if (withCast) params.with_cast = withCast;
    if (withCrew) params.with_crew = withCrew;

    const tmdbData = await tmdb("/discover/movie", params);
    let results = tmdbData.results || [];

    // /discover can't honor free text, so when a person filter is combined with a
    // title query, match the title server-side on the person-filtered page.
    if (q && (withCast || withCrew)) {
      const needle = q.toLowerCase();
      results = results.filter((m) => String(m.title || "").toLowerCase().includes(needle));
    }

    return results;
  };

  // cacheEmpty:!q — a free-text search can transiently filter a page down to zero,
  // so don't freeze that empty; a no-query /discover page's empty is stable.
  const data = await movieCache.getFeed(keyParams, fetchFromTmdb, { cacheEmpty: !q });
  res.json({ ok: true, data });
}

// GET /api/movies/random — one random movie, contract envelope.
async function random(req, res) {
  const { movie } = await pickRandomMovie();
  res.json({ ok: true, data: movie });
}

// GET /api/movies/cache-stats — read-only visibility into both cache tiers for
// dev/QA: how many movies are cached (detailed vs feed-only), how many feed pages
// are live, and the oldest/newest feedcache entry + when the oldest is due to be
// TTL-swept. Registered before /:id so the literal path isn't swallowed by the param.
async function cacheStats(req, res) {
  res.json({ ok: true, data: await movieCache.getStats() });
}

// Build the Movie Details payload from a raw TMDB /movie/:id response (with
// credits + videos appended). Trimmed to what the page renders: overview, genres,
// director, top cast, and a YouTube trailer key. Shared shape with the cached
// detail (movieCache.docToDetail) so served-from-Mongo details are identical.
function buildDetailPayload(movie) {
  const crew = (movie.credits && movie.credits.crew) || [];
  const director = crew.find((c) => c.job === "Director");

  const videos = (movie.videos && movie.videos.results) || [];
  // Prefer an official YouTube "Trailer"; fall back to any YouTube clip.
  const trailer =
    videos.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
    videos.find((v) => v.site === "YouTube");

  return {
    id: movie.id,
    title: movie.title || movie.original_title || "",
    release_date: movie.release_date || "",
    overview: movie.overview || "",
    tagline: movie.tagline || "",
    runtime: movie.runtime || null,
    vote_average: movie.vote_average || 0,
    poster_path: movie.poster_path || null,
    backdrop_path: movie.backdrop_path || null,
    genres: (movie.genres || []).map((g) => g.name),
    director: director ? director.name : "",
    cast: ((movie.credits && movie.credits.cast) || [])
      .slice(0, 4)
      .map((c) => c.name),
    trailerKey: trailer ? trailer.key : null,
  };
}

// GET /api/movies/:id — full details for one movie, used by the Movie Details
// page. Cache-first: a fully-detailed `movies` doc is served straight from Mongo
// (no TMDB call). On a miss or a feed-only (partial) doc, fetch from TMDB with
// credits + videos appended, return it, and persist with fullDetails:true so the
// next view is served from cache. Registered AFTER /api/movies/search and
// /api/movies/random so those literal paths aren't swallowed by the :id param.
async function details(req, res) {
  const id = Math.trunc(Number(req.params.id));
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error("Invalid movie id");
    err.status = 400;
    throw err;
  }

  // Served from Mongo when we already have the full detail fields.
  const cached = await movieCache.getCachedDetail(id);
  if (cached) return res.json({ ok: true, data: cached });

  const movie = await tmdb(`/movie/${id}`, {
    append_to_response: "credits,videos",
  });
  const payload = buildDetailPayload(movie);

  // Persist the full detail (best-effort; flips fullDetails:true for next time).
  await movieCache.saveDetail(id, movie, payload);

  res.json({ ok: true, data: payload });
}

module.exports = {
  search,
  random,
  cacheStats,
  details,
};
