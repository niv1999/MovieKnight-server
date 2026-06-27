// Non-owners get 404 (never 403) on private collections so existence isn't leaked.

const Collection = require("../models/Collection");
const Movie = require("../models/Movie");
const User = require("../models/User");
const { tmdb } = require("../services/tmdb");
const { dbReady } = require("../services/movieCache");

const MAX_NAME = 60;

// default lists can't be renamed or deleted
function assertEditableName(collection) {
  if (collection.isDefault) {
    const err = new Error("Default collections can't be renamed or deleted");
    err.status = 400;
    throw err;
  }
}

function cleanName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) {
    const err = new Error("Collection name is required");
    err.status = 400;
    throw err;
  }
  return name.slice(0, MAX_NAME);
}

function itemsInOrder(collection) {
  return [...(collection.items || [])].sort((a, b) => {
    const so = (a.sortOrder || 0) - (b.sortOrder || 0);
    if (so !== 0) return so;
    return new Date(a.addedAt || 0) - new Date(b.addedAt || 0);
  });
}

function toCard(collection, coversById, author, isOwner) {
  const ordered = itemsInOrder(collection);
  const covers = ordered.slice(0, 4).map((it) => {
    const c = coversById.get(it.movieId) || {};
    return { poster: c.poster || null, backdrop: c.backdrop || null };
  });
  return {
    id: String(collection._id),
    name: collection.name,
    isDefault: !!collection.isDefault,
    isPublic: !!collection.isPublic,
    posterUrl: collection.posterUrl || null,
    sort: collection.sort || "added_desc",
    movieCount: ordered.length,
    movieIds: ordered.map((it) => it.movieId),
    covers,
    likesCount: 0,
    savesCount: 0,
    author: author || null,
    isOwner: !!isOwner,
    createdAt: collection.createdAt,
  };
}

function toMovieCard(item, doc) {
  return {
    id: item.movieId,
    title: doc ? doc.title || "" : "",
    poster_path: doc ? doc.posterPath || null : null,
    vote_average: doc ? doc.rating ?? null : null,
    release_date:
      doc && doc.releaseDate ? doc.releaseDate.toISOString().slice(0, 10) : "",
    releaseYear: doc ? doc.releaseYear ?? null : null,
    // facets hydrated at add-time so the grid filters client-side without a per-movie lookup
    genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids : [],
    provider_ids: Array.isArray(item.provider_ids) ? item.provider_ids : [],
    addedAt: item.addedAt,
    sortOrder: item.sortOrder || 0,
  };
}

function toFull(collection, movieDocsById, author, isOwner) {
  const ordered = itemsInOrder(collection);
  const movies = ordered.map((it) => toMovieCard(it, movieDocsById.get(it.movieId)));
  return {
    id: String(collection._id),
    name: collection.name,
    isDefault: !!collection.isDefault,
    isPublic: !!collection.isPublic,
    posterUrl: collection.posterUrl || null,
    sort: collection.sort || "added_desc",
    author: author || null,
    authorId: String(collection.userId),
    isOwner: !!isOwner,
    movieCount: movies.length,
    likesCount: 0,
    savesCount: 0,
    createdAt: collection.createdAt,
    movies,
  };
}

async function coversFor(movieIds) {
  const map = new Map();
  if (!movieIds.length || !dbReady()) return map;
  const docs = await Movie.find(
    { _id: { $in: movieIds } },
    "posterPath backdropPath"
  ).lean();
  docs.forEach((d) =>
    map.set(d._id, { poster: d.posterPath || null, backdrop: d.backdropPath || null })
  );
  return map;
}

// always hits TMDB: list/search endpoints don't carry watch providers and providers
// drift, so a fresh fetch is the only source of current filter facets. a bad-id error
// propagates rather than storing an un-filterable item.
async function hydrateMovieOnAdd(tmdbId) {
  const movie = await tmdb(`/movie/${tmdbId}`, {
    append_to_response: "watch/providers",
  });

  const genre_ids = Array.isArray(movie.genres)
    ? movie.genres.map((g) => g && g.id).filter((id) => Number.isFinite(id))
    : [];

  // providers nest under the literal "watch/providers" key; flatrate = US streaming tier
  const wp = movie["watch/providers"];
  const usFlatrate = wp && wp.results && wp.results.US && wp.results.US.flatrate;
  const provider_ids = Array.isArray(usFlatrate)
    ? usFlatrate.map((p) => p && p.provider_id).filter((id) => Number.isFinite(id))
    : [];

  // warm the movie cache, best-effort
  if (dbReady()) {
    try {
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
      console.error("⚠️  movie cache warm failed for", tmdbId, "-", err.message);
    }
  }

  return { genre_ids, provider_ids };
}

async function findOr404(id) {
  let collection = null;
  try {
    collection = await Collection.findById(id);
  } catch (_) {
    collection = null; // malformed ObjectId is just "not found"
  }
  if (!collection) {
    const err = new Error("Collection not found");
    err.status = 404;
    throw err;
  }
  return collection;
}

function assertOwner(collection, req) {
  if (!req.user || !collection.userId.equals(req.user._id)) {
    const err = new Error("Collection not found");
    err.status = 404; // don't reveal someone else's collection exists
    throw err;
  }
}

// GET /api/collections
async function listMine(req, res) {
  const filter = { userId: req.user._id };
  if (req.query.isDefault === "true") filter.isDefault = true;
  else if (req.query.isDefault === "false") filter.isDefault = false;

  const cols = await Collection.find(filter)
    .sort({ isDefault: -1, createdAt: 1 })
    .lean();

  // every collection's first 4 movie ids, fetched in one query
  const wantedIds = new Set();
  cols.forEach((c) =>
    itemsInOrder(c)
      .slice(0, 4)
      .forEach((it) => wantedIds.add(it.movieId))
  );
  const coversById = await coversFor([...wantedIds]);

  const author = req.user.username;
  const data = cols.map((c) => toCard(c, coversById, author, true));
  res.json({ ok: true, data });
}

// POST /api/collections - empty list; auto-names "My Collection N" when no name given
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

// GET /api/collections/:id - non-owner sees a public collection in visitor mode;
// a private one is owner-only (else 404).
async function getOne(req, res) {
  const collection = await findOr404(req.params.id);

  const isOwner = collection.userId.equals(req.user._id);
  if (!collection.isPublic && !isOwner) {
    const err = new Error("Collection not found");
    err.status = 404;
    throw err;
  }

  const movieIds = (collection.items || []).map((it) => it.movieId);
  const movieDocsById = new Map();
  if (movieIds.length && dbReady()) {
    const docs = await Movie.find({ _id: { $in: movieIds } }).lean();
    docs.forEach((d) => movieDocsById.set(d._id, d));
  }

  // look up username separately; .populate() would mutate userId into a User object,
  // breaking authorId in toFull
  let author = isOwner ? req.user.username : null;
  if (!author) {
    const owner = await User.findById(collection.userId)
      .select("username")
      .lean()
      .catch(() => null);
    author = owner && owner.username ? owner.username : "Unknown";
  }

  res.json({ ok: true, data: toFull(collection, movieDocsById, author, isOwner) });
}

// PATCH /api/collections/:id - owner only. Body: { name?, isPublic?, sort? }.
async function update(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const body = req.body || {};
  let provided = false; // a recognised field was sent
  let changed = false; // a value actually differs, gates the write

  if (body.name !== undefined) {
    provided = true;
    assertEditableName(collection);
    const name = cleanName(body.name);
    if (name !== collection.name) {
      collection.name = name;
      changed = true;
    }
  }
  if (body.isPublic !== undefined) {
    provided = true;
    const next = !!body.isPublic;
    if (next !== collection.isPublic) {
      collection.isPublic = next;
      changed = true;
    }
  }
  if (body.sort !== undefined) {
    provided = true;
    if (!Collection.SORT_KEYS.includes(body.sort)) {
      const err = new Error("Invalid sort option");
      err.status = 400;
      throw err;
    }
    if (body.sort !== collection.sort) {
      collection.sort = body.sort;
      changed = true;
    }
  }

  if (!provided) {
    const err = new Error("No updatable fields provided");
    err.status = 400;
    throw err;
  }

  if (changed) await collection.save();

  const firstIds = itemsInOrder(collection)
    .slice(0, 4)
    .map((it) => it.movieId);
  const coversById = await coversFor(firstIds);
  res.json({ ok: true, data: toCard(collection, coversById, req.user.username, true) });
}

// DELETE /api/collections/:id - owner only; defaults can't be deleted.
async function remove(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);
  assertEditableName(collection);

  await collection.deleteOne();
  res.json({ ok: true, data: { deleted: true, id: String(collection._id) } });
}

// POST /api/collections/:id/movies - owner only. Body: { tmdbId }. Idempotent.
async function addMovie(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const tmdbId = Math.trunc(Number(req.body && req.body.tmdbId));
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    const err = new Error("A valid movie id is required");
    err.status = 400;
    throw err;
  }

  const already = (collection.items || []).some((it) => it.movieId === tmdbId);
  if (!already) {
    const { genre_ids, provider_ids } = await hydrateMovieOnAdd(tmdbId);
    collection.items.push({
      movieId: tmdbId,
      addedAt: new Date(),
      genre_ids,
      provider_ids,
    });
    await collection.save();
  }

  await respondFull(collection, req, res);
}

// DELETE /api/collections/:id/movies/:tmdbId - owner only.
async function removeMovie(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const tmdbId = Math.trunc(Number(req.params.tmdbId));
  collection.items = (collection.items || []).filter((it) => it.movieId !== tmdbId);
  await collection.save();

  await respondFull(collection, req, res);
}

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

const MAX_WHEEL_ITEMS = 100;

function cleanWheel(raw) {
  if (!Array.isArray(raw)) {
    const err = new Error("wheelConfig must be an array");
    err.status = 400;
    throw err;
  }
  return raw
    .map((entry) => (entry == null ? "" : String(entry).trim()))
    .filter(Boolean)
    .slice(0, MAX_WHEEL_ITEMS);
}

// GET /api/collections/:id/wheel
async function getWheel(req, res) {
  const collection = await findOr404(req.params.id);

  const isOwner = collection.userId.equals(req.user._id);
  if (!collection.isPublic && !isOwner) {
    const err = new Error("Collection not found");
    err.status = 404;
    throw err;
  }

  res.json({ ok: true, data: { wheelConfig: collection.savedWheel || [] } });
}

// PUT /api/collections/:id/wheel - owner only. Body: { wheelConfig: [...] }.
async function saveWheel(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const incoming = (req.body || {}).wheelConfig;
  if (incoming === undefined) {
    const err = new Error("wheelConfig is required");
    err.status = 400;
    throw err;
  }

  collection.savedWheel = cleanWheel(incoming);
  await collection.save();

  res.json({
    ok: true,
    data: { saved: true, wheelConfig: collection.savedWheel },
  });
}

// GET /api/collections/:id/wheel/filters - distinct genre + provider ids across this
// collection's movies. facets are embedded per item, so no TMDB call and no movies join.
async function wheelFilters(req, res) {
  const collection = await findOr404(req.params.id);

  const isOwner = collection.userId.equals(req.user._id);
  if (!collection.isPublic && !isOwner) {
    const err = new Error("Collection not found");
    err.status = 404;
    throw err;
  }

  const genres = new Set();
  const providers = new Set();
  for (const item of collection.items || []) {
    for (const g of item.genre_ids || []) if (Number.isFinite(g)) genres.add(g);
    for (const p of item.provider_ids || []) if (Number.isFinite(p)) providers.add(p);
  }

  res.json({
    ok: true,
    data: {
      availableGenres: [...genres],
      availableProviders: [...providers],
    },
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
  getWheel,
  saveWheel,
  wheelFilters,
  // shared with aiController
  findOr404,
  assertOwner,
};
