// controllers/movieController.js — movie endpoints backed by the TMDB proxy.
// All routes return the contract envelope { ok:true, data } / { ok:false, error }.
// Handlers are plain async (req, res); the routes/ layer wraps them with route().

const { tmdb, clampPage, randInt } = require("../services/tmdb");
const movieCache = require("../services/movieCache");

const RANDOM_MAX_ID = 1_200_000; // rough upper bound of TMDB movie IDs
const RANDOM_MAX_ATTEMPTS = 20; // fail-safe so the loop can't hang the server

// Pick one truly random (often obscure), non-adult movie.
// TMDB has no native random endpoint, so we brute-force it: pick a random ID,
// fetch /movie/{id}, and retry on a 404 (dead ID) or an adult title. To avoid
// hanging when we keep hitting dead/adult IDs, we cap attempts and fall back to
// a random title from the popular feed (pages 1–500).
// Returns { movie, fallback } — fallback is true when the loop maxed out.
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
// (/search/movie ignores sort_by entirely; the text path preserves TMDB's
// relevance order and only sorts within the page when a sort is explicitly chosen.)
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

// Free-text search via TMDB /search/movie. Returned RAW — we deliberately do NOT
// apply any sort or filter when there's a text query. /search/movie already ranks
// by text-match relevance (typo tolerant, the canonical original above its
// sequels/spin-offs), and re-sorting or filtering that page would only bury the
// title the user actually searched for. Sort and filters apply to the discover feed
// (empty q) only. `page` is forwarded 1:1 to TMDB so pages stay full as you scroll.
const searchByText = async (q, page) => {
  const data = await tmdb("/search/movie", { query: q, include_adult: "false", page });
  return data.results || [];
};

// ===========================================================================
// /api contract handlers — envelope { ok:true, data } / { ok:false, error }.
// ===========================================================================

// GET /api/movies/search — movie feed with continuous pagination. Two modes:
//   • Free-text (q present): TMDB /search/movie, returned by relevance. Sort and
//     ALL filters are intentionally IGNORED — search is pure text relevance, so the
//     canonical original ranks above its sequels and typos are tolerated.
//   • Discover (q empty): /discover/movie with sort + every filter as native params.
// Params: q, genre, yearFrom, yearTo, minRating, minVotes, language, with_cast,
// with_crew, providers, certification, sort (default popularity), page.
//
// `page` maps 1:1 to the underlying TMDB page (TMDB serves up to page 500), so
// result sets don't shrink as you scroll — we return an empty array only when TMDB
// itself runs out of pages.
async function search(req, res) {
  const q = String(req.query.q || "").trim();
  const sort = SORTERS[req.query.sort] ? req.query.sort : DEFAULT_SORT;
  const page = clampPage(req.query.page);

  // genre may be a single id or a comma/pipe-joined multi-id (e.g. "28,12").
  // Parse to a numeric list. Number("28,12") is NaN, which silently blanked the
  // grid (genre_ids.includes(NaN) is always false) — so split first. Multi-genre
  // is OR (match ANY): users expect "Action or Comedy", and TMDB's comma-AND
  // yields near-empty results for uncommon combinations.
  const genreIds = String(req.query.genre || "")
    .split(/[,|]/)
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  const yearFrom = req.query.yearFrom ? Number(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo ? Number(req.query.yearTo) : null;
  const minRating = req.query.minRating ? Number(req.query.minRating) : null;
  const minVotes = req.query.minVotes ? Number(req.query.minVotes) : null;
  const language = req.query.language ? String(req.query.language).trim() : null;
  const withCast = req.query.with_cast ? String(req.query.with_cast) : null;
  const withCrew = req.query.with_crew ? String(req.query.with_crew) : null;
  // Streaming-provider filter. Accept `providers` or `with_watch_providers`, single
  // or comma/pipe-joined ids (e.g. "8,9"). OR semantics ("on Netflix OR Disney+"),
  // which TMDB expresses with "|". with_watch_providers is IGNORED by TMDB unless a
  // watch_region accompanies it — omitting the region is why provider filtering
  // silently returned everything/"unavailable". Default the region to US.
  const providerIds = String(req.query.providers || req.query.with_watch_providers || "")
    .split(/[,|]/)
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  const watchRegion = String(req.query.watch_region || "US").trim().toUpperCase() || "US";
  // Age-rating (certification) filter, e.g. "R" or "PG-13". Certifications are
  // country-specific, so a country is always required; default to US. We only treat
  // certification as active when a value is actually provided — the country alone
  // filters nothing.
  const certification = req.query.certification ? String(req.query.certification).trim() : null;
  const certificationCountry =
    String(req.query.certification_country || "US").trim().toUpperCase() || "US";

  // Fingerprint the request for the feed cache. A free-text search ignores sort and
  // every filter (pure /search/movie relevance), so when q is present the result
  // depends ONLY on q + page — key on just those so filter/sort permutations of the
  // same query share one cached page. The empty-q discover feed keys on sort + every
  // filter. genre is kept as its RAW query string (it may be a comma-joined multi-id
  // like "28,12"); the rest are the normalized single values. Two requests with the
  // same fingerprint share a cached page; anything that changes the results changes
  // the key. NOTE: any NEW filter added to the discover params below MUST also be
  // added here, or two different queries would collide on one (wrong) cached page.
  const keyParams = q
    ? { q, page }
    : {
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
        providers: providerIds.length ? providerIds.join("|") : null,
        watch_region: providerIds.length ? watchRegion : null,
        certification,
        certification_country: certification ? certificationCountry : null,
      };

  // The real TMDB fetch — only runs on a cache miss (or when Mongo is unavailable).
  const fetchFromTmdb = async () => {
    // Any free-text query goes to /search/movie and is returned by relevance, with
    // sort and ALL filters intentionally ignored (search is pure text relevance).
    if (q) return searchByText(q, page);

    // Empty q -> the discover feed, with every filter as a native param and the
    // page forwarded straight through.
    const params = {
      include_adult: "false",
      sort_by: SORT_BY[sort],
      page,
    };
    if (genreIds.length) params.with_genres = genreIds.join("|"); // "|" = OR in TMDB
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
    if (providerIds.length) {
      params.with_watch_providers = providerIds.join("|"); // "|" = OR (any provider)
      params.watch_region = watchRegion; // REQUIRED — TMDB ignores providers without it
    }
    if (certification !== null) {
      params.certification = certification;
      params.certification_country = certificationCountry; // REQUIRED — TMDB ignores certification without it
    }

    const tmdbData = await tmdb("/discover/movie", params);
    return tmdbData.results || [];
  };

  // cacheEmpty:!q — only freeze empties for the stable discover feed. A free-text
  // search's empty is conservatively left uncached (TMDB relevance can shift), so a
  // later identical query re-fetches rather than serving a frozen empty page.
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
