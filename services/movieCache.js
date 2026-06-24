// services/movieCache.js — the movie caching layer that sits between the TMDB
// proxy controllers and Mongo. Two tiers (see docs/DATA_MODEL.md):
//
//   1. `movies`    — canonical movie content, kept ~forever. Volatile numbers
//                    (rating/popularity) are refreshed opportunistically on every
//                    write. `fullDetails` tracks whether the detail-only fields
//                    (cast/director/trailer/tagline/runtime) have been filled in.
//   2. `feedcache` — ordered TMDB-id lists per query+page, TTL'd to 12h.
//
// Design rules baked in here:
//   • The cache is TRANSPARENT: a hit must return the exact same shape as a miss,
//     so callers (and api.js) can't tell them apart. We always emit TMDB-shaped
//     result objects (poster_path, vote_average, release_date) and store BARE
//     image paths, letting the client prefix the CDN base as it already does.
//   • The cache is BEST-EFFORT: any Mongo failure (or no DB at all) silently
//     falls back to a direct TMDB fetch, so the proxy still works with an empty
//     .env (per CLAUDE.md). DB errors are logged, never thrown to the client.
//   • Writes only $set the fields they actually have, so a feed-level refresh can
//     never clobber detail-only fields or reset `fullDetails`.

const mongoose = require("mongoose");
const Movie = require("../models/Movie");
const FeedCache = require("../models/FeedCache");
const { tmdb } = require("./tmdb");

// Is the shared Mongoose connection usable right now? 1 === connected. During a
// cold start (state 2 = connecting) or when MONGODB_URI is unset (state 0) this
// is false, and every cache path transparently degrades to a direct TMDB call.
function dbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

// Build the canonical cache key from the request's distinguishing params. Sorted
// keys + dropped empties mean param order and defaulted/absent fields can't
// produce two keys for the same logical query. Values are kept as-is (genre may
// be a comma-joined multi-id string like "28,12", so we DON'T coerce to Number
// here — that would collide distinct multi-genre queries to NaN).
function feedKey(params) {
  const norm = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(norm);
}

// --- shape mappers -------------------------------------------------------------

// Parse TMDB's "YYYY-MM-DD" into a Date, or null when absent/invalid.
function parseReleaseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Extract the numeric release year from TMDB's "YYYY-MM-DD", or null when the
// string is absent or its leading 4 chars don't parse to a truthy number.
function releaseYearFromDate(s) {
  return s ? Number(String(s).slice(0, 4)) || null : null;
}

// A raw TMDB *list* result -> the feed-level fields we persist. BARE image paths;
// NO detail-only fields and NO fullDetails (those are owned by saveDetail).
function feedFields(r) {
  return {
    title: r.title || r.original_title || "",
    releaseYear: releaseYearFromDate(r.release_date),
    releaseDate: parseReleaseDate(r.release_date),
    posterPath: r.poster_path || null,
    backdropPath: r.backdrop_path || null,
    overview: r.overview || "",
    rating: r.vote_average ?? null,
    popularity: r.popularity ?? null,
    lastUpdated: new Date(),
  };
}

// A Mongo movie doc -> a TMDB-shaped *list* result, so a cache HIT is byte-for-byte
// the same shape as a MISS (which returns raw TMDB objects). Only the fields the
// home grid consumes are reconstructed; that's all the search results carry.
function docToResult(doc) {
  return {
    id: doc._id,
    title: doc.title || "",
    poster_path: doc.posterPath || null,
    backdrop_path: doc.backdropPath || null,
    overview: doc.overview || "",
    // null (not 0) for missing numbers — matches feedFields' convention and the
    // raw-TMDB MISS path, so a HIT and a MISS stay the same shape (the client
    // coerces both with ?? 0 anyway).
    vote_average: doc.rating ?? null,
    popularity: doc.popularity ?? null,
    release_date: doc.releaseDate ? doc.releaseDate.toISOString().slice(0, 10) : "",
  };
}

// A Mongo movie doc -> the GET /api/movies/:id detail payload. Mirrors the live
// payload the controller builds from TMDB, so served-from-cache details are
// indistinguishable from a fresh fetch.
function docToDetail(doc) {
  return {
    id: doc._id,
    title: doc.title || "",
    release_date: doc.releaseDate ? doc.releaseDate.toISOString().slice(0, 10) : "",
    overview: doc.overview || "",
    tagline: doc.tagline || "",
    runtime: doc.runtime ?? null,
    vote_average: doc.rating ?? 0,
    poster_path: doc.posterPath || null,
    backdrop_path: doc.backdropPath || null,
    genres: Array.isArray(doc.genres) ? doc.genres : [],
    director: doc.director || "",
    cast: Array.isArray(doc.cast) ? doc.cast : [],
    trailerKey: doc.trailerKey || null,
  };
}

// --- feed (search/discover) cache ---------------------------------------------

// Upsert every result into `movies` (warms tier 1 + refreshes volatile numbers).
// $set lists ONLY feed-level fields; $setOnInsert seeds fullDetails:false just on
// creation so a refresh never resets an already-detailed doc back to partial.
// Uses allSettled (not all): one bad document in a page mustn't discard the ~19
// that succeeded. Returns the SET of ids that actually persisted so the caller can
// record only the survivors in feedcache (never an id whose movie doc failed).
async function persistResults(results) {
  const valid = results.filter((r) => r && r.id != null);
  if (!valid.length) return new Set();
  const outcomes = await Promise.allSettled(
    valid.map((r) =>
      Movie.updateOne(
        { _id: r.id },
        { $set: feedFields(r), $setOnInsert: { fullDetails: false } },
        { upsert: true }
      )
    )
  );
  const persisted = new Set();
  outcomes.forEach((o, i) => {
    if (o.status === "fulfilled") persisted.add(valid[i].id);
    else console.error("⚠️  movie upsert failed for id", valid[i].id, "-", o.reason && o.reason.message);
  });
  return persisted;
}

// Read a cached page. Returns the ORDERED, TMDB-shaped results on a hit, an empty
// array for a legitimately-empty cached query, or null on a miss / unusable cache.
async function readFeed(key) {
  if (!dbReady()) return null;
  const entry = await FeedCache.findById(key);
  if (!entry) return null; // miss
  const ids = entry.movieIds || [];
  if (!ids.length) return []; // a real "0 results" answer was cached — still a hit
  // $in returns docs in arbitrary order, so re-impose the stored order (= the sort
  // the query asked for). Drop any movie that's since been evicted from `movies`.
  const docs = await Movie.find({ _id: { $in: ids } });
  const byId = new Map(docs.map((d) => [d._id, d]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map(docToResult);
}

// Store a freshly-fetched page: warm `movies`, then record the ordered id list of
// the movies that ACTUALLY persisted (so feedcache can never reference a movie doc
// that failed to store). upsert (not create) so a not-yet-TTL-swept stale key is
// refreshed, not a dup-key error. Order = exactly the order TMDB/our sort returned.
async function writeFeed(key, results) {
  const persisted = await persistResults(results);
  const movieIds = results
    .filter((r) => r && r.id != null && persisted.has(r.id))
    .map((r) => r.id);

  // Had results but none could be persisted (e.g. a mid-batch Mongo failure) ->
  // skip the entry; caching [] here would wrongly serve "no results" for 12h.
  if (results.length > 0 && movieIds.length === 0) return;

  await FeedCache.updateOne(
    { _id: key },
    { $set: { movieIds, fetchedAt: new Date() } },
    { upsert: true }
  );
}

// The feed entry point. `keyParams` fingerprints the request; `fetchFromTmdb` is a
// thunk doing the real TMDB call. Cache hit -> from Mongo (no TMDB); miss -> fetch,
// store best-effort, return. Cache failures degrade to a plain fetch and are never
// surfaced to the caller. A TMDB error from the thunk propagates normally (it's not
// caught here), so it's reported once — never double-fetched.
//
// options.cacheEmpty (default true): whether a 0-result answer should be cached.
// A genuinely-empty /discover page is a stable answer worth caching; but a text
// search that fetched one TMDB page and then filtered it down to nothing is a
// TRANSIENT empty — caching it would serve "no results" for 12h, so callers with a
// free-text query pass cacheEmpty:false to let it re-fetch.
async function getFeed(keyParams, fetchFromTmdb, options = {}) {
  const { cacheEmpty = true } = options;
  if (!dbReady()) return fetchFromTmdb();

  const key = feedKey(keyParams);

  let hit = null;
  try {
    hit = await readFeed(key);
  } catch (err) {
    console.error("⚠️  feed cache read failed:", err.message);
  }
  if (hit !== null) return hit;

  const results = await fetchFromTmdb();
  const list = Array.isArray(results) ? results : [];

  if (!(list.length === 0 && !cacheEmpty)) {
    try {
      await writeFeed(key, list);
    } catch (err) {
      console.error("⚠️  feed cache write failed:", err.message);
    }
  }

  return results;
}

// --- movie details cache -------------------------------------------------------

// Return the cached detail payload IFF we have a fully-detailed doc; otherwise null
// (miss, partial/feed-only doc, or unusable cache) so the caller fetches from TMDB.
async function getCachedDetail(id) {
  if (!dbReady()) return null;
  try {
    const doc = await Movie.findById(id);
    if (doc && doc.fullDetails) return docToDetail(doc);
  } catch (err) {
    console.error("⚠️  detail cache read failed:", err.message);
  }
  return null;
}

// Persist a full detail fetch: every field from the detail payload + the raw
// movie's volatile numbers, flipping fullDetails:true. Best-effort; never throws.
// `movie` is the raw TMDB /movie/:id response, `payload` the controller's built
// detail object (shared shape with docToDetail).
async function saveDetail(id, movie, payload) {
  if (!dbReady()) return;
  try {
    await Movie.updateOne(
      { _id: id },
      {
        $set: {
          title: payload.title,
          releaseYear: releaseYearFromDate(movie.release_date),
          releaseDate: parseReleaseDate(movie.release_date),
          posterPath: payload.poster_path,
          backdropPath: payload.backdrop_path,
          overview: payload.overview,
          tagline: payload.tagline,
          runtime: payload.runtime,
          rating: payload.vote_average,
          popularity: movie.popularity ?? null,
          director: payload.director,
          cast: payload.cast,
          genres: payload.genres,
          trailerKey: payload.trailerKey,
          fullDetails: true,
          lastUpdated: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("⚠️  detail cache write failed:", err.message);
  }
}

// Build the GET /api/movies/:id detail payload from a raw TMDB /movie/:id response
// (with credits + videos appended). Trimmed to what the page renders: overview,
// genres, director, top cast, a YouTube trailer key. SAME shape as docToDetail, so a
// fresh fetch and a cache hit are byte-for-byte identical.
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
    cast: ((movie.credits && movie.credits.cast) || []).slice(0, 4).map((c) => c.name),
    trailerKey: trailer ? trailer.key : null,
  };
}

// Fetch-once-store-forever for ONE movie's full details, by TMDB id — the generic
// "give me this movie, I don't care from where" primitive. Mongo first: a
// fully-detailed doc is returned without touching TMDB. On a miss (or a feed-only
// partial doc) it fetches /movie/:id with credits+videos, persists it with
// fullDetails:true, and returns the SAME detail-payload shape either way. This is
// how we WARM the cache: any caller that resolves a movie (the details page, AI
// enhance, …) leaves it stored for the next one. Throws on a TMDB failure (e.g. a
// 404 dead id); with Mongo unavailable it simply fetches without caching, so it
// still works on an empty .env.
async function retrieveMovie(id) {
  const cached = await getCachedDetail(id);
  if (cached) return cached; // Mongo hit — no TMDB call
  const movie = await tmdb(`/movie/${id}`, { append_to_response: "credits,videos" });
  const payload = buildDetailPayload(movie);
  await saveDetail(id, movie, payload); // store forever (best-effort)
  return payload;
}

// --- cache visibility (dev/QA) -------------------------------------------------

// A snapshot of both cache tiers for GET /api/movies/cache-stats. Best-effort:
// returns { dbConnected:false } when Mongo isn't available rather than throwing.
async function getStats() {
  if (!dbReady()) return { dbConnected: false };

  const [movieTotal, movieDetailed, feedTotal, oldest, newest] = await Promise.all([
    Movie.countDocuments({}),
    Movie.countDocuments({ fullDetails: true }),
    FeedCache.countDocuments({}),
    FeedCache.findOne().sort({ fetchedAt: 1 }).select("fetchedAt").lean(),
    FeedCache.findOne().sort({ fetchedAt: -1 }).select("fetchedAt").lean(),
  ]);

  const ttlSeconds = FeedCache.FEED_TTL_SECONDS;
  // When the oldest entry is due to be swept (fetchedAt + TTL) — lets you watch the
  // TTL index actually evict entries.
  const oldestExpiresAt =
    oldest && oldest.fetchedAt
      ? new Date(oldest.fetchedAt.getTime() + ttlSeconds * 1000)
      : null;

  return {
    dbConnected: true,
    movies: {
      total: movieTotal,
      detailed: movieDetailed, // fullDetails:true (served from Mongo on the detail page)
      partial: movieTotal - movieDetailed, // feed-only docs awaiting a first detail view
    },
    feedCache: {
      entries: feedTotal, // live cached query+page combinations
      ttlSeconds,
      oldestEntry: oldest ? oldest.fetchedAt : null,
      newestEntry: newest ? newest.fetchedAt : null,
      oldestExpiresAt,
    },
  };
}

module.exports = {
  dbReady,
  feedKey,
  getFeed,
  getCachedDetail,
  saveDetail,
  retrieveMovie,
  getStats,
};
