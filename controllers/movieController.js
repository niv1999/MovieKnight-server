// controllers/movieController.js — movie endpoints backed by the TMDB proxy.
// All routes return the contract envelope { ok:true, data } / { ok:false, error }.
// Handlers are plain async (req, res); the routes/ layer wraps them with route().

const { tmdb, clampPage, randInt } = require("../services/tmdb");
const movieCache = require("../services/movieCache");

const SURPRISE_DEFAULT_PAGES = 50; // ?pages default — pool ≈ the top 1,000 popular titles

// Allowable `sortBy` values for /api/movies/search and their TMDB /discover `sort_by`
// mapping. These are SEMANTIC names the client requests by intent; the client never
// sees (or sends) a TMDB sort string, so the mapping below is the single place that
// owns "what does this sort actually mean" — change the retrieval logic here and the
// client is untouched. Notably the two popularity-style sorts:
//   • popularity ("Most Popular" / overall) -> vote_count.desc — the most-rated/viewed
//     titles of ALL TIME (Fight Club, Pulp Fiction, Inception, ...).
//   • trending ("Popular this week") -> popularity.desc — TMDB's recency-weighted
//     "hot right now" score, which surfaces what's currently being watched/searched.
// Both run through /discover, so every filter applies natively. (TMDB has no title
// sort, so title_* -> original_title.*; year_* -> primary_release_date.*.)
// (/search/movie ignores sort_by entirely; the text path is pure relevance.)
const DEFAULT_SORT = "popularity";
const SORT_BY = {
  popularity: "vote_count.desc",
  trending: "popularity.desc",
  rating_desc: "vote_average.desc",
  rating_asc: "vote_average.asc",
  title_asc: "original_title.asc",
  title_desc: "original_title.desc",
  year_desc: "primary_release_date.desc",
  year_asc: "primary_release_date.asc",
};
const isValidSort = (s) => Boolean(SORT_BY[s]);

// Default vote floor for rating sorts so a handful of single-vote 10.0 titles
// don't dominate. Only applied when the caller didn't set their own minVotes.
const RATING_SORT_VOTE_FLOOR = 50;

// Free-text search via TMDB /search/movie. Returned RAW — we deliberately do NOT
// apply any sort or filter when there's a text query. /search/movie already ranks
// by text-match relevance (the canonical original above its sequels/spin-offs), and
// re-sorting or filtering that page would only bury the title the user actually
// searched for. (It normalizes case/accents but is NOT fuzzy — a real misspelling
// returns whatever TMDB returns, i.e. usually nothing; we don't second-guess it.)
// Sort and filters apply to the discover feed (empty q) only. `page` is forwarded
// 1:1 to TMDB so pages stay full as you scroll.
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
//     canonical original ranks above its sequels. (TMDB's text match is not fuzzy.)
//   • Discover (q empty): /discover/movie with the chosen sort + every filter as
//     native params. The `sortBy` value is a SEMANTIC intent the server maps to a
//     TMDB sort_by (see SORT_BY) — e.g. `popularity` = all-time most-rated
//     (vote_count.desc); `trending` = what's hot this week (popularity.desc). Both go
//     through /discover so every filter applies natively.
// Params: q, genre, yearFrom, yearTo, minRating, minVotes, language, with_cast,
// with_crew, providers, certification, sortBy (default popularity), page.
//
// `page` maps 1:1 to the underlying TMDB page (TMDB serves up to page 500), so
// result sets don't shrink as you scroll — we return an empty array only when TMDB
// itself runs out of pages.
async function search(req, res) {
  const q = String(req.query.q || "").trim();
  // `sortBy` is the semantic sort intent (popularity/trending/...), never a TMDB
  // sort_by string — the server owns the mapping (see SORT_BY).
  const sort = isValidSort(req.query.sortBy) ? req.query.sortBy : DEFAULT_SORT;
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
  // Streaming-provider filter (`providers`): single or comma/pipe-joined ids (e.g.
  // "8,9"). OR semantics ("on Netflix OR Disney+"), which TMDB expresses with "|".
  // The outbound TMDB param with_watch_providers is IGNORED unless a watch_region
  // accompanies it — omitting the region is why provider filtering silently returned
  // everything/"unavailable". Default the region to US.
  const providerIds = String(req.query.providers || "")
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
  // same query share one cached page. The discover feed keys on sort + every filter.
  // genre is kept as its RAW query string (it may be a comma-joined multi-id like
  // "28,12"); the rest are the normalized single values. Two requests with the same
  // fingerprint share a cached page; anything that changes the results changes the
  // key. NOTE: any NEW filter added below MUST also be added here, or two different
  // queries would collide on one (wrong) cached page.
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

    // Empty q -> the discover feed, with the mapped sort + every filter as native
    // params and the page forwarded straight through.
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

  // cacheEmpty:!q — only freeze empties for the stable discover feed (every sort,
  // incl. trending, is now a /discover query whose empty is a deterministic TMDB
  // result). A free-text search's empty is left uncached (TMDB relevance can shift),
  // so a later identical query re-fetches rather than serving a frozen empty page.
  const data = await movieCache.getFeed(keyParams, fetchFromTmdb, { cacheEmpty: !q });
  res.json({ ok: true, data });
}

// Pick one random — but recognizable — movie. TMDB has no native random endpoint, so
// rather than brute-forcing random IDs (which mostly surfaced obscure/foreign/
// posterless titles), we draw from the popular, well-voted, English discover feed —
// the SAME pool as the default home feed — and return a random title from a random
// page within the first `pages` pages. A bigger `pages` widens the pool toward more
// obscure picks; a smaller one keeps it mainstream.
async function pickRandomMovie(pages) {
  const pickFromPage = async (page) => {
    const data = await tmdb("/discover/movie", {
      include_adult: "false",
      sort_by: SORT_BY.popularity, // vote_count.desc — all-time most-voted
      "vote_count.gte": 500, // quality floor — mirrors the home default feed
      with_original_language: "en",
      page,
    });
    const results = data.results || [];
    return results.length ? results[randInt(0, results.length - 1)] : null;
  };

  // A high random page can fall past a thin result set — retry once from page 1 so
  // the button still returns something.
  const page = randInt(1, pages);
  return (await pickFromPage(page)) || (page !== 1 ? pickFromPage(1) : null);
}

// GET /api/movies/random — one random (but recognizable) movie, contract envelope.
// `?pages=N` caps how many pages of the popular feed to randomize from (default 50,
// clamped to TMDB's 1–500). The client will later derive N from a user setting
// (movies-to-randomize-from ÷ 20); for now it sends no param and gets the default.
async function random(req, res) {
  const pages =
    req.query.pages != null ? clampPage(req.query.pages) : SURPRISE_DEFAULT_PAGES;
  const movie = await pickRandomMovie(pages);
  res.json({ ok: true, data: movie });
}

// GET /api/movies/cache-stats — read-only visibility into both cache tiers for
// dev/QA: how many movies are cached (detailed vs feed-only), how many feed pages
// are live, and the oldest/newest feedcache entry + when the oldest is due to be
// TTL-swept. Registered before /:id so the literal path isn't swallowed by the param.
async function cacheStats(req, res) {
  res.json({ ok: true, data: await movieCache.getStats() });
}

// GET /api/movies/:id — full details for one movie, used by the Movie Details
// page. Delegates to movieCache.retrieveMovie: a fully-detailed `movies` doc is
// served straight from Mongo (no TMDB call); a miss/partial fetches from TMDB
// (credits + videos), returns it, and persists with fullDetails:true so the next
// view — here OR via AI enhance — is served from cache. Registered AFTER
// /api/movies/search and /api/movies/random so those literal paths aren't swallowed
// by the :id param.
async function details(req, res) {
  const id = Math.trunc(Number(req.params.id));
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error("Invalid movie id");
    err.status = 400;
    throw err;
  }

  res.json({ ok: true, data: await movieCache.retrieveMovie(id) });
}

module.exports = {
  search,
  random,
  cacheStats,
  details,
};
