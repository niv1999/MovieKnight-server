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
// visibility, counts, and the first ≤4 movies' images for the auto-generated cover.
function toCard(collection, coversById, author, isOwner) {
  const ordered = itemsInOrder(collection);
  // First ≤4 movies, in order, each paired { poster, backdrop } (either may be
  // null). The client cover generator picks the image type it needs per layout.
  const covers = ordered.slice(0, 4).map((it) => {
    const c = coversById.get(it.movieId) || {};
    return { poster: c.poster || null, backdrop: c.backdrop || null };
  });
  return {
    id: String(collection._id),
    name: collection.name,
    isDefault: !!collection.isDefault,
    isPublic: !!collection.isPublic,
    posterUrl: collection.posterUrl || null, // custom cover overrides the collage
    sort: collection.sort || "added_desc", // remembered "Sort by"
    movieCount: ordered.length,
    movieIds: ordered.map((it) => it.movieId), // all TMDB ids — cheap membership checks (heart/eye)
    covers, // first ≤4 movies as { poster, backdrop } bare TMDB paths (client prefixes the CDN
            // and picks poster/backdrop per layout). The cover's single source of truth.
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
    // Filter facets live on the embedded item (hydrated at add-time), so the grid
    // can be filtered client-side without a per-movie lookup.
    genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids : [],
    provider_ids: Array.isArray(item.provider_ids) ? item.provider_ids : [],
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
    sort: collection.sort || "added_desc", // remembered "Sort by"
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

// Fetch poster + backdrop paths for a set of movie ids in one query
// → Map(id → { poster, backdrop }). The client cover generator needs BOTH so it
// can pick poster or backdrop per layout/viewport (see buildCollectionCover).
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

// Hydrate a movie being added to a collection: fetch its full TMDB details +
// US watch providers in one call, warm the shared `movies` cache (so the
// cover/grid has a poster — "cache on add", SPRINT_PLAN S5), and return the
// filter facets (genre_ids, provider_ids) to embed on the collection item.
//
// Unlike a cache-only warm, this ALWAYS hits TMDB on add: list/search endpoints
// don't carry watch providers, and providers drift over time, so a fresh fetch is
// the only way to get current filter data. Adding to a collection is a rare,
// user-initiated action, so the extra call is cheap. The TMDB error on a bad/unknown
// id propagates (the add fails with that status) rather than silently storing an
// un-filterable item. Cache-warming is best-effort: a Mongo write failure is logged
// but never blocks the add.
async function hydrateMovieOnAdd(tmdbId) {
  const movie = await tmdb(`/movie/${tmdbId}`, {
    append_to_response: "watch/providers",
  }); // throws (e.g. 404) on a bad id

  // TMDB /movie/:id returns genres as [{ id, name }] — collapse to ids.
  const genre_ids = Array.isArray(movie.genres)
    ? movie.genres.map((g) => g && g.id).filter((id) => Number.isFinite(id))
    : [];

  // append_to_response nests the providers under the literal "watch/providers" key.
  // Default region US; flatrate = the streaming (subscription) tier the filter uses.
  const wp = movie["watch/providers"];
  const usFlatrate = wp && wp.results && wp.results.US && wp.results.US.flatrate;
  const provider_ids = Array.isArray(usFlatrate)
    ? usFlatrate.map((p) => p && p.provider_id).filter((id) => Number.isFinite(id))
    : [];

  // Warm tier-1 cache (best-effort). We don't gate on a cache hit here because we
  // needed the TMDB call for the facets anyway; this keeps poster/title fresh too.
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

// GET /api/collections — the signed-in user's collections as lightweight cards.
// Defaults first, then by creation order. Query filter:
//   ?isDefault=true   default lists only (Favorites etc.) — wires the heart/eye
//                     buttons to membership.
//   ?isDefault=false  custom lists only.
// (Browsing OTHER users' public lists belongs to a separate, paginated Explore
//  endpoint — deliberately out of scope here.)
async function listMine(req, res) {
  const filter = { userId: req.user._id };
  if (req.query.isDefault === "true") filter.isDefault = true;
  else if (req.query.isDefault === "false") filter.isDefault = false;

  const cols = await Collection.find(filter)
    .sort({ isDefault: -1, createdAt: 1 })
    .lean();

  // Gather the first ≤4 movie ids of every collection, fetch all their images in
  // ONE query, then build the cards.
  const wantedIds = new Set();
  cols.forEach((c) =>
    itemsInOrder(c)
      .slice(0, 4)
      .forEach((it) => wantedIds.add(it.movieId))
  );
  const coversById = await coversFor([...wantedIds]);

  // Every collection here is the caller's own, so they're always the owner.
  const author = req.user.username;
  const data = cols.map((c) => toCard(c, coversById, author, true));
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

// PATCH /api/collections/:id — owner only. Body: { name?, isPublic?, sort? }.
// Powers inline rename, the Publish/Unpublish toggle, and remembering the chosen
// "Sort by". Renaming a default collection is rejected (400); toggling its
// visibility or sort is allowed (defaults are sortable like any other list).
async function update(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const body = req.body || {};
  let provided = false; // a recognised field was sent (else it's a bad request)
  let changed = false; // a value actually differs (gates the DB write)

  if (body.name !== undefined) {
    provided = true;
    assertEditableName(collection); // defaults can't be renamed
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

  // Setting a field to its current value is a valid idempotent request, not an
  // error — only touch Mongo when something actually changed; otherwise this is a
  // silent no-op that still returns the current card with 200.
  if (changed) await collection.save();

  // Rebuild the card shape (with cover images) so the client can refresh in place.
  const firstIds = itemsInOrder(collection)
    .slice(0, 4)
    .map((it) => it.movieId);
  const coversById = await coversFor(firstIds);
  res.json({ ok: true, data: toCard(collection, coversById, req.user.username, true) });
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
    const err = new Error("A valid movie id is required");
    err.status = 400;
    throw err;
  }

  const already = (collection.items || []).some((it) => it.movieId === tmdbId);
  if (!already) {
    // Fetch details + US providers, warm the cache, and capture the filter facets.
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

// ===========================================================================
// Wheel persistence (Spin the Wheel) — GET/PUT /api/collections/:id/wheel.
// The wheel config is the embedded collection.savedWheel ([String]); the client
// persists its wheel as a plain array of strings (titles / free-form entries), so
// we store it byte-for-byte. GET follows the same visibility rule as getOne (owner
// or a PUBLIC collection); PUT is owner-only — only the owner edits their wheel.
// ===========================================================================

const MAX_WHEEL_ITEMS = 100; // a wheel that large is already unusable; this caps abuse

// Normalise an incoming wheel array to [String] (the stored shape). Accepts the
// client's string entries as-is, and also tolerates numbers (TMDB ids) or objects
// (TMDB movie objects → prefer title/name/id) so the endpoint matches an
// "array of TMDB movie objects/IDs" payload without changing the storage model.
function cleanWheel(raw) {
  if (!Array.isArray(raw)) {
    const err = new Error("wheelConfig must be an array");
    err.status = 400;
    throw err;
  }
  return raw
    .map((entry) => {
      if (entry == null) return "";
      if (typeof entry === "object") {
        return String(entry.title ?? entry.name ?? entry.id ?? "").trim();
      }
      return String(entry).trim();
    })
    .filter(Boolean)
    .slice(0, MAX_WHEEL_ITEMS);
}

// GET /api/collections/:id/wheel — the saved wheel config for a viewable collection.
async function getWheel(req, res) {
  const collection = await findOr404(req.params.id);

  const isOwner = !!req.user && collection.userId.equals(req.user._id);
  if (!collection.isPublic && !isOwner) {
    const err = new Error("Collection not found"); // don't leak a private collection
    err.status = 404;
    throw err;
  }

  res.json({ ok: true, data: { wheelConfig: collection.savedWheel || [] } });
}

// PUT /api/collections/:id/wheel — owner only. Body: { wheelConfig: [...] }.
async function saveWheel(req, res) {
  const collection = await findOr404(req.params.id);
  assertOwner(collection, req);

  const body = req.body || {};
  // Accept { wheelConfig }, { savedWheel }, or a bare array body.
  const incoming =
    body.wheelConfig !== undefined
      ? body.wheelConfig
      : body.savedWheel !== undefined
      ? body.savedWheel
      : Array.isArray(body)
      ? body
      : undefined;

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

// NOTE: the wheel filtering itself is client-side — the full collection payload
// (toFull → toMovieCard) already ships genre_ids + provider_ids per movie, so the
// "Spin the Wheel" UI filters the user's own collection without an extra round-trip
// (genre OR, provider OR). The endpoint below only exposes the SET of facet ids
// actually present, so the UI can build filter chips that never match zero movies.

// GET /api/collections/:id/wheel/filters — the distinct genre + provider ids that
// actually appear across THIS collection's movies, so the Wheel UI can offer only
// filters that match something. Pure Mongo read: the facets are already embedded on
// each item (genre_ids / provider_ids, hydrated at add-time + backfilled), so there
// is NO TMDB call and not even a movies join — one collection lookup is enough.
// Visibility follows getWheel (owner, or a PUBLIC collection); a private/foreign
// collection is 404 (existence not leaked). Provider ids are US flatrate only, so a
// collection of non-streaming titles legitimately returns availableProviders: [].
async function wheelFilters(req, res) {
  const collection = await findOr404(req.params.id);

  const isOwner = !!req.user && collection.userId.equals(req.user._id);
  if (!collection.isPublic && !isOwner) {
    const err = new Error("Collection not found"); // don't leak a private collection
    err.status = 404;
    throw err;
  }

  // Union the per-item facets into ordered, de-duped id lists (insertion order =
  // first-seen across items; the client maps ids → names via /api/genres,/providers).
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
  // Shared with the AI controller (controllers/aiController.js) so the
  // ownership / 404-not-403 rules live in exactly one place.
  findOr404,
  assertOwner,
};
