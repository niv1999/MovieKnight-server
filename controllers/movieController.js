const { tmdb, clampPage, randInt } = require("../services/tmdb");
const movieCache = require("../services/movieCache");

const SURPRISE_DEFAULT_PAGES = 50;

// client sends semantic sort intents, not raw TMDB strings. popularity -> vote_count.desc
// (all-time most-voted), trending -> popularity.desc. no title sort in TMDB so title_* -> original_title.*.
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

// vote floor for rating sorts so single-vote 10.0 titles don't dominate; skipped if caller set minVotes
const RATING_SORT_VOTE_FLOOR = 50;

// returned raw: /search/movie ranks by relevance, re-sorting would bury the searched title
const searchByText = async (q, page) => {
  const data = await tmdb("/search/movie", { query: q, include_adult: "false", page });
  return data.results || [];
};

async function search(req, res) {
  const q = String(req.query.q || "").trim();
  const sort = isValidSort(req.query.sortBy) ? req.query.sortBy : DEFAULT_SORT;
  const page = clampPage(req.query.page);

  // split before parsing: Number("28,12") is NaN. multi-genre uses OR.
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
  // TMDB ignores with_watch_providers without a watch_region, so default region to US
  const providerIds = String(req.query.providers || "")
    .split(/[,|]/)
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  const watchRegion = String(req.query.watch_region || "US").trim().toUpperCase() || "US";
  // certifications are country-specific, so country always required; default US
  const certification = req.query.certification ? String(req.query.certification).trim() : null;
  const certificationCountry =
    String(req.query.certification_country || "US").trim().toUpperCase() || "US";

  // feed cache key. any new filter below MUST be added here or distinct queries collide on a cached page.
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

  const fetchFromTmdb = async () => {
    if (q) return searchByText(q, page);

    const params = {
      include_adult: "false",
      sort_by: SORT_BY[sort],
      page,
    };
    if (genreIds.length) params.with_genres = genreIds.join("|");
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
      params.with_watch_providers = providerIds.join("|");
      params.watch_region = watchRegion; // required, else TMDB ignores providers
    }
    if (certification !== null) {
      params.certification = certification;
      params.certification_country = certificationCountry; // required, else TMDB ignores certification
    }

    const tmdbData = await tmdb("/discover/movie", params);
    return tmdbData.results || [];
  };

  // cache empties only for the deterministic discover feed, not free-text search
  const data = await movieCache.getFeed(keyParams, fetchFromTmdb, { cacheEmpty: !q });
  res.json({ ok: true, data });
}

// no TMDB random endpoint and random ids hit obscure/posterless titles, so draw a
// random title from a random page of the popular well-voted English discover feed
async function pickRandomMovie(pages) {
  const pickFromPage = async (page) => {
    const data = await tmdb("/discover/movie", {
      include_adult: "false",
      sort_by: SORT_BY.popularity,
      "vote_count.gte": 500,
      with_original_language: "en",
      page,
    });
    const results = data.results || [];
    return results.length ? results[randInt(0, results.length - 1)] : null;
  };

  // a high random page can land past a thin result set, retry once from page 1
  const page = randInt(1, pages);
  return (await pickFromPage(page)) || (page !== 1 ? pickFromPage(1) : null);
}

async function random(req, res) {
  const pages =
    req.query.pages != null ? clampPage(req.query.pages) : SURPRISE_DEFAULT_PAGES;
  const movie = await pickRandomMovie(pages);
  res.json({ ok: true, data: movie });
}

// must register before /:id so the literal path isn't swallowed by the param
async function cacheStats(req, res) {
  res.json({ ok: true, data: await movieCache.getStats() });
}

// must register after the literal /search and /random paths so they aren't swallowed by :id
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
