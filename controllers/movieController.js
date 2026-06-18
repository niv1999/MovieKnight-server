// controllers/movieController.js — movie endpoints backed by the TMDB proxy.
// All routes return the contract envelope { ok:true, data } / { ok:false, error }.
// Handlers are plain async (req, res); the routes/ layer wraps them with route().

const { tmdb, clampPage, randInt } = require("../services/tmdb");

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

const SEARCH_PAGE_SIZE = 20; // movies returned per response page
const SEARCH_SOURCE_PAGES = 5; // TMDB pages pulled before sorting (caps the sort window at ~100)

// Source feed for search. Cast/crew filtering only exists on /discover (TMDB's
// /search/movie ignores it), so any person filter forces the discover endpoint;
// otherwise a `q` uses text search and a bare request uses the popular catalog.
// Quality-control filters (minVotes -> vote_count.gte, language ->
// with_original_language) are TMDB-native and so are pushed into every /discover
// call; the /search/movie path can't honor them, so the handler also applies
// them server-side (see below).
const searchSource = (q, page, { withCast, withCrew, minVotes, language } = {}) => {
  // Discover-only filters that TMDB applies natively on the catalog feed.
  const discoverFilters = {};
  if (minVotes !== null && minVotes !== undefined) discoverFilters["vote_count.gte"] = minVotes;
  if (language) discoverFilters.with_original_language = language;

  if (withCast || withCrew) {
    const params = { include_adult: "false", sort_by: "popularity.desc", page, ...discoverFilters };
    if (withCast) params.with_cast = withCast;
    if (withCrew) params.with_crew = withCrew;
    return tmdb("/discover/movie", params);
  }
  if (q) {
    return tmdb("/search/movie", { query: q, include_adult: "false", page });
  }
  return tmdb("/discover/movie", {
    include_adult: "false",
    sort_by: "popularity.desc",
    page,
    ...discoverFilters,
  });
};

// ===========================================================================
// /api contract handlers — envelope { ok:true, data } / { ok:false, error }.
// ===========================================================================

// GET /api/movies/search — text search with server-side filtering, sorting, and
// pagination. Params: q, genre, yearFrom, yearTo, minRating, with_cast, with_crew,
// sort (default popularity), page. Empty q -> popular movies feed. Sorting is
// global across a capped window of source results (not just one TMDB page).
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
  const filters = { withCast, withCrew, minVotes, language };

  // Pull a capped window so the sort spans more than a single TMDB page.
  const first = await searchSource(q, 1, filters);
  const sourcePages = Math.min(SEARCH_SOURCE_PAGES, first.total_pages || 1);
  let results = first.results || [];
  if (sourcePages > 1) {
    const rest = await Promise.all(
      Array.from({ length: sourcePages - 1 }, (_, i) => searchSource(q, i + 2, filters))
    );
    for (const r of rest) results = results.concat(r.results || []);
  }

  // A person filter forces the discover endpoint, which can't honor free text,
  // so match the title query client-side when both are supplied.
  if ((withCast || withCrew) && q) {
    const needle = q.toLowerCase();
    results = results.filter((m) =>
      String(m.title || "").toLowerCase().includes(needle)
    );
  }

  // Server-side filtering.
  if (genre !== null) {
    results = results.filter((m) => (m.genre_ids || []).includes(genre));
  }
  if (yearFrom !== null || yearTo !== null) {
    results = results.filter((m) => {
      const y = releaseYear(m);
      if (y === null) return false; // undated titles excluded when a year range is set
      if (yearFrom !== null && y < yearFrom) return false;
      if (yearTo !== null && y > yearTo) return false;
      return true;
    });
  }
  if (minRating !== null) {
    results = results.filter((m) => (m.vote_average || 0) >= minRating);
  }
  // Quality-control filters. /discover honors these natively (passed through
  // searchSource); re-apply server-side so the /search/movie text path, which
  // ignores them, stays consistent.
  if (minVotes !== null) {
    results = results.filter((m) => (m.vote_count || 0) >= minVotes);
  }
  if (language !== null) {
    results = results.filter((m) => m.original_language === language);
  }

  // Server-side sort, then paginate the ordered list.
  results.sort(SORTERS[sort]);
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const data = results.slice(start, start + SEARCH_PAGE_SIZE);

  res.json({ ok: true, data });
}

// GET /api/movies/random — one random movie, contract envelope.
async function random(req, res) {
  const { movie } = await pickRandomMovie();
  res.json({ ok: true, data: movie });
}

// GET /api/movies/:id — full details for one movie, used by the Movie Details
// page. One TMDB call with credits + videos appended, trimmed to what the page
// renders: overview, genres, director, top cast, and a YouTube trailer key.
// Registered AFTER /api/movies/search and /api/movies/random so those literal
// paths aren't swallowed by the :id param.
async function details(req, res) {
  const id = Math.trunc(Number(req.params.id));
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error("Invalid movie id");
    err.status = 400;
    throw err;
  }

  const movie = await tmdb(`/movie/${id}`, {
    append_to_response: "credits,videos",
  });

  const crew = (movie.credits && movie.credits.crew) || [];
  const director = crew.find((c) => c.job === "Director");

  const videos = (movie.videos && movie.videos.results) || [];
  // Prefer an official YouTube "Trailer"; fall back to any YouTube clip.
  const trailer =
    videos.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
    videos.find((v) => v.site === "YouTube");

  res.json({
    ok: true,
    data: {
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
    },
  });
}

module.exports = {
  search,
  random,
  details,
};
