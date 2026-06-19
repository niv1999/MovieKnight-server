// controllers/collectionController.js — Collections CRUD (S5).
// Implements the Collections lane of docs/API_CONTRACT.md. Every response uses the
// contract envelope { ok:true, data } / { ok:false, error }; handlers are plain
// async (req, res) wrapped by utils/route() in the routes layer.
//
// Ownership model (docs/DATA_MODEL.md): a collection's owner is collections.userId,
// taken from the JWT — routes never nest under /users/:id. Reads of a PUBLIC
// collection are allowed for anyone (guest or other user → "visitor mode");
// a PRIVATE collection is visible only to its owner (others get 404, never 403, so
// a private collection's existence isn't leaked — see getOne).
//
// Likes/Saves are deferred (Explore — SPRINT_PLAN §11.8). We expose a stable
// `likesCount`/`savesCount` of 0 so the client contract is fixed now, but there is
// no like/save storage or toggling yet.

const Collection = require("../models/Collection");
const Movie = require("../models/Movie");
const User = require("../models/User");
const { tmdb } = require("../services/tmdb");
const { dbReady } = require("../services/movieCache");

const MAX_NAME = 60; // collection title cap

// The 3 seeded lists can't be renamed or deleted (DATA_MODEL / FR-4.6.7).
function assertEditableName(collection) {
  if (collection.isDefault) {
    const err = new Error("Default collections can't be renamed or deleted");
    err.status = 400;
    throw err;
  }
}

// Validate + normalise a collection name from a request body. Throws a 400 on a
// missing/blank name; trims and caps length.
function cleanName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) {
    const err = new Error("Collection name is required");
    err.status = 400;
    throw err;
  }
  return name.slice(0, MAX_NAME);
}

// --- shape mappers -------------------------------------------------------------
// Collection items embed only a movieId (→ movies._id). The cards/grid need the
// movie's poster/title/etc., so we join against the `movies` cache and emit
// TMDB-shaped movie objects (bare poster_path, vote_average, release_date) — the
// SAME shape the movie feed returns, so api.js's normaliser handles both.

// Items in their stored (chronological add) order. `posterUrl` (custom cover) wins
// over the auto-collage when set (FR-4.6.6).
function itemsInOrder(collection) {
  return [...(collection.items || [])].sort((a, b) => {
    const so = (a.sortOrder || 0) - (b.sortOrder || 0);
    if (so !== 0) return so;
    return new Date(a.addedAt || 0) - new Date(b.addedAt || 0);
  });
}

// The lightweight "card" shape used by the profile grid (list + create): identity,
// visibility, counts, and up to 4 poster paths for the auto-generated 2×2 collage.
function toCard(collection, postersById, author, isOwner) {
  const ordered = itemsInOrder(collection);
  const posters = ordered
    .map((it) => postersById.get(it.movieId))
    .filter(Boolean)
    .slice(0, 4);
  return {
    id: String(collection._id),
    name: collection.name,
    isDefault: !!collection.isDefault,
    isPublic: !!collection.isPublic,
    posterUrl: collection.posterUrl || null, // custom cover overrides the collage
    movieCount: ordered.length,
    posters, // bare TMDB paths for the first ≤4 movies (client prefixes the CDN)
    likesCount: 0, // deferred (Explore) — always 0 for now
    savesCount: 0,
    author: author || null,
    isOwner: !!isOwner,
    createdAt: collection.createdAt,
  };
}

// One embedded item + its joined movie doc -> a TMDB-shaped grid card.
function toMovieCard(item, doc) {
  return {
    id: item.movieId,
    title: doc ? doc.title || "" : "",
    poster_path: doc ? doc.posterPath || null : null,
    vote_average: doc ? doc.rating ?? null : null,
    release_date:
      doc && doc.releaseDate ? doc.releaseDate.toISOString().slice(0, 10) : "",
    releaseYear: doc ? doc.releaseYear ?? null : null,
    addedAt: item.addedAt,
    sortOrder: item.sortOrder || 0,
  };
}

// The full collection-page payload: identity + the joined movie objects
// (complex query #2). `author` is the owner's username; `isOwner` toggles the
// owner vs visitor UI on the client.
function toFull(collection, movieDocsById, author, isOwner) {
  const ordered = itemsInOrder(collection);
  const movies = ordered.map((it) => toMovieCard(it, movieDocsById.get(it.movieId)));
  return {
    id: String(collection._id),
    name: collection.name,
    isDefault: !!collection.isDefault,
    isPublic: !!collection.isPublic,
    posterUrl: collection.posterUrl || null,
    author: author || null,
    authorId: String(collection.userId),
    isOwner: !!isOwner,
    movieCount: movies.length,
    likesCount: 0, // deferred (Explore)
    savesCount: 0,
    createdAt: collection.createdAt,
    movies,
  };
}

// Fetch poster paths for a set of movie ids in one query → Map(id → posterPath).
async function postersFor(movieIds) {
  const map = new Map();
  if (!movieIds.length || !dbReady()) return map;
  const docs = await Movie.find(
    { _id: { $in: movieIds } },
    "posterPath"
  ).lean();
  docs.forEach((d) => map.set(d._id, d.posterPath || null));
  return map;
}

// Ensure a movie is present in the `movies` cache before it's referenced by a
// collection item, so the cover/grid always has a poster to show ("cache on add",
// SPRINT_PLAN S5). Most added movies were already warmed by a prior search, so the
// TMDB call only happens for a cold id. Best-effort: a cache write failure must not
// block the add (the item still references a valid TMDB id).
async function ensureMovieCached(tmdbId) {
  if (!dbReady()) return;
  try {
    const existing = await Movie.findById(tmdbId).select("_id").lean();
    if (existing) return;
    const movie = await tmdb(`/movie/${tmdbId}`); // throws 404 on a bad id
    await Movie.updateOne(
      { _id: tmdbId },
      {
        $set: {
          title: movie.title || movie.original_title || "",
          releaseYear: movie.release_date
            ? Number(String(movie.release_date).slice(0, 4)) || null
            : null,
          releaseDate: movie.release_date ? new Date(movie.release_date) : null,
          posterPath: movie.poster_path || null,
          backdropPath: movie.backdrop_path || null,
          overview: movie.overview || "",
          rating: movie.vote_average ?? null,
          popularity: movie.popularity ?? null,
          lastUpdated: new Date(),
        },
        $setOnInsert: { fullDetails: false },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("⚠️  ensureMovieCached failed for", tmdbId, "-", err.message);
  }
}

// Load a collection by id or throw a 404. Used by every /:id handler.
async function findOr404(id) {
  let collection = null;
  try {
    collection = await Collection.findById(id);
  } catch (_) {
    collection = null; // a malformed ObjectId is just "not found"
  }
  if (!collection) {
    const err = new Error("Collection not found");
    err.status = 404;
    throw err;
  }
  return collection;
}

// Owner guard for mutating routes: the signed-in user must own the collection.
function assertOwner(collection, req) {
  if (!req.user || !collection.userId.equals(req.user._id)) {
    const err = new Error("Collection not found");
    err.status = 404; // don't reveal someone else's collection exists
    throw err;
  }
}

// ===========================================================================
// Handlers
// ===========================================================================

// GET /api/collections — the signed-in user's own collections (profile grid).
// Defaults first, then by creation order. Each carries up to 4 poster paths for
// the collage cover.
async function listMine(req, res) {
  const cols = await Collection.find({ userId: req.user._id })
    .sort({ isDefault: -1, createdAt: 1 })
    .lean();

  // Gather the first ≤4 movie ids of every collection, fetch all their posters in
  // ONE query, then build the cards.
  const wantedIds = new Set();
  cols.forEach((c) =>
    itemsInOrder(c)
      .slice(0, 4)
      .forEach((it) => wantedIds.add(it.movieId))
  );
  const postersById = await postersFor([...wantedIds]);

  const data = cols.map((c) => toCard(c, postersById, req.user.username, true));
  res.json({ ok: true, data });
}

// POST /api/collections — create a new (empty) collection. Body: { name? }.
// With no name, auto-names "My Collection N" (FR-4.6.5) where N keeps it unique
// among the user's existing custom lists.
async function create(req, res) {
  let name = String((req.body && req.body.name) || "").trim();
  if (!name) {
    const count = await Collection.countDocuments({
      userId: req.user._id,
      isDefault: false,
    });
    name = `My Collection ${count + 1}`;
  }
  name = name.slice(0, MAX_NAME);

  const collection = await Collection.create({
    userId: req.user._id,
    name,
    isPublic: false,
    isDefault: false,
  });

  res
    .status(201)
    .json({ ok: true, data: toCard(collection, new Map(), req.user.username, true) });
}

// GET /api/collections/:id — one collection + its joined movies (complex query #2).
// requireAuth-gated (Explore is login-only): a logged-in non-owner sees a PUBLIC
// collection in visitor mode; a PRIVATE one is owner-only (else 404). Guests never
// reach here — requireAuth 401s them and the client redirects to login.
async function getOne(req, res) {
  const collection = await findOr404(req.params.id);

  const isOwner = !!req.user && collection.userId.equals(req.user._id);
  if (!collection.isPublic && !isOwner) {
    // private + not the owner → 404, never 403 (don't leak existence)
    const err = new Error("Collection not found");
    err.status = 404;
    throw err;
  }

  // Join items[] → movies cache in one query (the "collection with movies"
  // aggregation requirement), then re-impose the stored item order.
  const movieIds = (collection.items || []).map((it) => it.movieId);
  const movieDocsById = new Map();
  if (movieIds.length && dbReady()) {
    const docs = await Movie.find({ _id: { $in: movieIds } }).lean();
    docs.forEach((d) => movieDocsById.set(d._id, d));
  }

  // Owner's username for the "By <author>" line. Look it up separately rather than
  // .populate()-ing the collection doc (populate mutates collection.userId into the
  // User object, which would then break the authorId stringify in toFull).
  let author = isOwner && req.user ? req.user.username : null;
  if (!author) {
    const owner = await User.findById(collection.userId)
      .select("username")
      .lean()
      .catch(() => null);
    author = owner && owner.username ? owner.username : "Unknown";
  }

  res.json({ ok: true, data: toFull(collection, movieDocsById, author, isOwner) });
}

// PATCH /api/collections/:id — owner only. Body: { name?, isPublic? }.
// Powers inline rename + the Publish/Unpublish toggle. Renaming a default
// collection is rejected (400); toggling its visibility is allowed.
async function update(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const body = req.body || {};
  let touched = false;

  if (body.name !== undefined) {
    assertEditableName(collection); // defaults can't be renamed
    collection.name = cleanName(body.name);
    touched = true;
  }
  if (body.isPublic !== undefined) {
    collection.isPublic = !!body.isPublic;
    touched = true;
  }

  if (!touched) {
    const err = new Error("No updatable fields provided");
    err.status = 400;
    throw err;
  }

  await collection.save();

  // Rebuild the card shape (with collage posters) so the client can refresh in place.
  const firstIds = itemsInOrder(collection)
    .slice(0, 4)
    .map((it) => it.movieId);
  const postersById = await postersFor(firstIds);
  res.json({ ok: true, data: toCard(collection, postersById, req.user.username, true) });
}

// DELETE /api/collections/:id — owner only; the 3 defaults can't be deleted.
async function remove(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);
  assertEditableName(collection); // defaults are undeletable

  await collection.deleteOne();
  res.json({ ok: true, data: { deleted: true, id: String(collection._id) } });
}

// POST /api/collections/:id/movies — owner only. Body: { tmdbId }.
// Adds the movie if not already present (idempotent), warming the movies cache so
// the cover/grid has a poster. Returns the full collection + movies.
async function addMovie(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const tmdbId = Math.trunc(Number(req.body && req.body.tmdbId));
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    const err = new Error("A valid tmdbId is required");
    err.status = 400;
    throw err;
  }

  const already = (collection.items || []).some((it) => it.movieId === tmdbId);
  if (!already) {
    await ensureMovieCached(tmdbId); // store the movie before referencing it
    collection.items.push({ movieId: tmdbId, addedAt: new Date() });
    await collection.save();
  }

  await respondFull(collection, req, res);
}

// DELETE /api/collections/:id/movies/:tmdbId — owner only. Removes the movie.
async function removeMovie(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const tmdbId = Math.trunc(Number(req.params.tmdbId));
  collection.items = (collection.items || []).filter((it) => it.movieId !== tmdbId);
  await collection.save();

  await respondFull(collection, req, res);
}

// Shared tail for add/removeMovie: re-join items→movies and return the full shape
// (so the client repaints the grid + count from one response).
async function respondFull(collection, req, res) {
  const movieIds = (collection.items || []).map((it) => it.movieId);
  const movieDocsById = new Map();
  if (movieIds.length && dbReady()) {
    const docs = await Movie.find({ _id: { $in: movieIds } }).lean();
    docs.forEach((d) => movieDocsById.set(d._id, d));
  }
  res.json({
    ok: true,
    data: toFull(collection, movieDocsById, req.user.username, true),
  });
}

module.exports = {
  listMine,
  create,
  getOne,
  update,
  remove,
  addMovie,
  removeMovie,
};
