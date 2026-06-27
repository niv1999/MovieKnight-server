// Movie cache between the TMDB controllers and Mongo. Two tiers: `movies` (canonical
// content kept ~forever) and `feedcache` (ordered id lists per query+page, TTL 12h).
// Invariants: a HIT returns the same shape as a MISS (TMDB-shaped, bare image paths);
// best-effort (any Mongo failure falls back to a direct TMDB fetch, logged not thrown);
// writes only $set the fields they have so a feed refresh never clobbers detail fields.

const mongoose = require("mongoose");
const Movie = require("../models/Movie");
const FeedCache = require("../models/FeedCache");
const { tmdb } = require("./tmdb");

// 1 === connected; otherwise cache paths degrade to a direct TMDB call
function dbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

// canonical cache key. sorted keys + dropped empties so param order / absent fields
// can't make two keys for one query. values kept as strings: genre may be "28,12".
function feedKey(params) {
  const norm = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(norm);
}

function parseReleaseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function releaseYearFromDate(s) {
  return s ? Number(String(s).slice(0, 4)) || null : null;
}

// raw TMDB list result -> the feed-level fields we persist (no detail fields)
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

// Mongo doc -> TMDB-shaped list result so a HIT matches a MISS. only the fields the
// home grid consumes are reconstructed.
function docToResult(doc) {
  return {
    id: doc._id,
    title: doc.title || "",
    poster_path: doc.posterPath || null,
    backdrop_path: doc.backdropPath || null,
    overview: doc.overview || "",
    // null (not 0) for missing numbers, matching the raw-TMDB miss path
    vote_average: doc.rating ?? null,
    popularity: doc.popularity ?? null,
    release_date: doc.releaseDate ? doc.releaseDate.toISOString().slice(0, 10) : "",
  };
}

// Mongo doc -> the /api/movies/:id detail payload, mirroring the fetch-built shape
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

// upsert every result into `movies`. $setOnInsert seeds fullDetails:false only on
// create so a refresh never resets a detailed doc to partial. allSettled so one bad
// doc doesn't drop the page. returns the ids that actually persisted.
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

// read a cached page: ordered TMDB-shaped results on a hit, [] for a cached empty
// query, or null on a miss / unusable cache.
async function readFeed(key) {
  if (!dbReady()) return null;
  const entry = await FeedCache.findById(key);
  if (!entry) return null;
  const ids = entry.movieIds || [];
  if (!ids.length) return []; // cached "0 results", still a hit
  // $in returns arbitrary order, so re-impose the stored order. drop evicted movies.
  const docs = await Movie.find({ _id: { $in: ids } });
  const byId = new Map(docs.map((d) => [d._id, d]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map(docToResult);
}

// store a fetched page: warm `movies`, then record only the ids that persisted so
// feedcache never references a doc that failed. upsert refreshes a stale key.
async function writeFeed(key, results) {
  const persisted = await persistResults(results);
  const movieIds = results
    .filter((r) => r && r.id != null && persisted.has(r.id))
    .map((r) => r.id);

  // had results but none persisted -> skip; caching [] would serve "no results" for 12h
  if (results.length > 0 && movieIds.length === 0) return;

  await FeedCache.updateOne(
    { _id: key },
    { $set: { movieIds, fetchedAt: new Date() } },
    { upsert: true }
  );
}

// feed entry point. hit -> from Mongo; miss -> run fetchFromTmdb thunk, store
// best-effort. cache failures degrade to a plain fetch; a TMDB error propagates.
// cacheEmpty (default true): a /discover empty is stable and worth caching, but a
// text search filtered to nothing is transient, so free-text callers pass false.
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

// cached detail payload only if the doc is fully detailed; else null so caller fetches
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

// persist a full detail fetch, flipping fullDetails:true. best-effort; never throws.
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

// build the /api/movies/:id detail payload from a raw TMDB response (credits+videos
// appended). same shape as docToDetail so a fetch and a cache hit match.
function buildDetailPayload(movie) {
  const crew = (movie.credits && movie.credits.crew) || [];
  const director = crew.find((c) => c.job === "Director");

  const videos = (movie.videos && movie.videos.results) || [];
  // prefer an official YouTube "Trailer", else any YouTube clip
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

// fetch-once-store-forever for one movie's full details by TMDB id. Mongo first;
// on a miss fetch /movie/:id with credits+videos and persist. throws on TMDB failure.
async function retrieveMovie(id) {
  const cached = await getCachedDetail(id);
  if (cached) return cached;
  const movie = await tmdb(`/movie/${id}`, { append_to_response: "credits,videos" });
  const payload = buildDetailPayload(movie);
  await saveDetail(id, movie, payload);
  return payload;
}

// snapshot of both cache tiers for GET /api/movies/cache-stats; best-effort
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
  const oldestExpiresAt =
    oldest && oldest.fetchedAt
      ? new Date(oldest.fetchedAt.getTime() + ttlSeconds * 1000)
      : null;

  return {
    dbConnected: true,
    movies: {
      total: movieTotal,
      detailed: movieDetailed,
      partial: movieTotal - movieDetailed, // feed-only docs not yet detailed
    },
    feedCache: {
      entries: feedTotal,
      ttlSeconds,
      oldestEntry: oldest ? oldest.fetchedAt : null,
      newestEntry: newest ? newest.fetchedAt : null,
      oldestExpiresAt,
    },
  };
}

module.exports = {
  dbReady,
  getFeed,
  retrieveMovie,
  getStats,
};
