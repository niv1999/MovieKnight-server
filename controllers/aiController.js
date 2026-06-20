// controllers/aiController.js — the three Gemini-backed AI features (see
// docs/SPRINT_PLAN.md §extras): "Let AI Choose", "AI Search", "Enhance Collection".
// Every response uses the contract envelope { ok:true, data } / { ok:false, error };
// handlers are plain async (req, res) wrapped by utils/route() in the routes layer.
//
// Division of labour:
//   • services/gemini.js owns the model config + JSON-mode plumbing.
//   • This file owns the PROMPTS (the strict JSON schema each feature expects) and
//     the mapping of Gemini's answer back onto real data — collection movies for
//     the picker, TMDB records for search/enhance. Gemini only ever ranks/suggests;
//     it never invents the data we return (we re-resolve everything ourselves).

const Movie = require("../models/Movie");
const { tmdb } = require("../services/tmdb");
const { dbReady } = require("../services/movieCache");
const { generateJsonArray } = require("../services/gemini");
const { findOr404, assertOwner } = require("./collectionController");

// Caps that keep us inside free-tier limits and bound the work per request.
const MAX_PICK = 3; // "Let AI Choose" returns at most this many
const MAX_SEARCH_RESULTS = 50; // "AI Search" resolves at most this many titles
const ENHANCE_COUNT = 3; // "Enhance Collection" recommends exactly this many
const TMDB_CONCURRENCY = 6; // parallel TMDB lookups when resolving AI titles

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

// Throw a 400 with `message` (the validation pattern used across controllers).
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// Fisher–Yates shuffle (returns a new array; never mutates the input). Used to
// vary the candidate order the picker hands Gemini so repeat calls differ.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Load a collection the signed-in user OWNS, or throw (404 if missing/not theirs —
// findOr404 + assertOwner keep the 404-not-403 rule in one place).
async function loadOwnedCollection(id, req) {
  const collection = await findOr404(id);
  assertOwner(collection, req);
  return collection;
}

// Join a collection's items[] → the `movies` cache and emit the compact records we
// hand to Gemini: just enough (title/year/genres) to rank by, keyed by TMDB id.
// Items whose movie isn't cached yet are skipped (nothing for the model to judge).
async function collectionMoviesForAi(collection) {
  const ids = (collection.items || []).map((it) => it.movieId);
  if (!ids.length || !dbReady()) return [];
  const docs = await Movie.find(
    { _id: { $in: ids } },
    "title releaseYear genres"
  ).lean();
  return docs
    .filter((d) => d.title)
    .map((d) => ({
      id: d._id, // TMDB id — this is the "movieId" Gemini must echo back
      title: d.title,
      year: d.releaseYear || null,
      genres: d.genres || [],
    }));
}

// A full movie doc → the TMDB-shaped grid card the client already knows how to
// render (same shape collectionController.toMovieCard emits, plus an AI `reason`).
function movieCardFromDoc(doc, reason) {
  return {
    id: doc._id,
    title: doc.title || "",
    poster_path: doc.posterPath || null,
    vote_average: doc.rating ?? null,
    release_date: doc.releaseDate
      ? new Date(doc.releaseDate).toISOString().slice(0, 10)
      : "",
    releaseYear: doc.releaseYear ?? null,
    reason: reason || "",
  };
}

// Resolve one AI-suggested { title, year } to a real TMDB record via /search/movie.
// Prefers an exact-year match, else the top (most popular) hit. Returns null on a
// miss OR a TMDB error — one bad lookup must not sink the whole batch, so callers
// just filter the nulls out.
async function findTmdbMovie(title, year) {
  const q = String(title || "").trim();
  if (!q) return null;
  try {
    const params = { query: q, include_adult: "false" };
    const y = parseInt(String(year || "").slice(0, 4), 10);
    if (Number.isFinite(y)) params.year = y; // narrows TMDB to that release year
    const data = await tmdb("/search/movie", params);
    const results = data.results || [];
    if (!results.length) return null;
    if (Number.isFinite(y)) {
      const exact = results.find(
        (m) => String(m.release_date || "").slice(0, 4) === String(y)
      );
      if (exact) return exact;
    }
    return results[0]; // TMDB orders by relevance/popularity
  } catch (_) {
    return null; // dead query / upstream blip — treat as a miss
  }
}

// Resolve a list of AI suggestions to TMDB records with a small concurrency cap
// (a 50-title search would otherwise fire 50 simultaneous TMDB calls). Preserves
// the AI's ordering and drops misses. `attach(rec, movie)` shapes each kept hit.
async function resolveSuggestions(suggestions, attach) {
  const out = new Array(suggestions.length).fill(null);
  let cursor = 0;
  async function worker() {
    while (cursor < suggestions.length) {
      const i = cursor++;
      const rec = suggestions[i];
      const movie = await findTmdbMovie(rec.title, rec.year);
      if (movie) out[i] = attach(rec, movie);
    }
  }
  const workers = Array.from(
    { length: Math.min(TMDB_CONCURRENCY, suggestions.length) },
    worker
  );
  await Promise.all(workers);

  // Drop misses and de-dupe by TMDB id (AI lists can repeat a title), keeping order.
  const seen = new Set();
  const deduped = [];
  for (const m of out) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push(m);
  }
  return deduped;
}

// ===========================================================================
// Endpoint 1 — POST /api/ai/picker  ("Let AI Choose")
// Body: { collectionId, prompt, count } → picks `count` movies FROM the user's
// collection that best match `prompt`, each with a one-line reason.
// ===========================================================================
async function picker(req, res) {
  const body = req.body || {};
  const collectionId = String(body.collectionId || "").trim();
  const prompt = String(body.prompt || "").trim();
  let count = Math.trunc(Number(body.count));

  if (!collectionId) badRequest("collectionId is required");
  if (!prompt) badRequest("prompt is required");
  if (!Number.isFinite(count) || count < 1) count = 1;
  count = Math.min(count, MAX_PICK); // hard cap 1..3

  const collection = await loadOwnedCollection(collectionId, req);
  const movies = await collectionMoviesForAi(collection);
  if (!movies.length) {
    badRequest("This collection has no movies to choose from");
  }
  // Can't return more picks than the collection holds.
  count = Math.min(count, movies.length);

  // "Try Again" sends the SAME body, so to surface a genuinely different set each
  // time we (a) shuffle the candidate order the model sees, (b) hand it a one-off
  // variation token, and (c) run at a higher temperature. Together these break the
  // determinism that otherwise returned identical picks on every press.
  const shuffled = shuffle(movies);
  const variationToken = Math.random().toString(36).slice(2, 10);

  // Strict schema prompt: the model must echo back movieIds FROM the given list
  // (so we can map them to real movies) and nothing else.
  const aiPrompt = [
    "You are a film curator. From the JSON list of movies below, select EXACTLY",
    `${count} movie(s) that best match this request: "${prompt}".`,
    "Only choose from the provided list — never invent titles.",
    "When several movies fit the request well, vary your selection so repeat",
    `requests surface different good picks. Variation token: ${variationToken}.`,
    'Respond with ONLY a JSON array of objects with this exact shape:',
    '[{ "movieId": <number, the id field from the list>, "reason": "<one short sentence>" }]',
    "No prose, no markdown, no code fences — just the JSON array.",
    "",
    "MOVIES:",
    JSON.stringify(shuffled),
  ].join("\n");

  // Higher temperature here (vs. the 0.4 default) so the picks aren't locked to the
  // single "most obvious" answer — that's what makes Try Again feel alive.
  const picks = await generateJsonArray(aiPrompt, { temperature: 1.0 });

  // Map the AI's ids back to real movie docs, dropping anything not actually in the
  // collection (guards against a hallucinated id). Preserve the AI's ordering.
  const docs = await Movie.find({ _id: { $in: movies.map((m) => m.id) } }).lean();
  const byId = new Map(docs.map((d) => [d._id, d]));

  const seen = new Set();
  const data = [];
  for (const pick of picks) {
    const id = Math.trunc(Number(pick && pick.movieId));
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const doc = byId.get(id);
    if (!doc) continue; // not in the collection — ignore
    seen.add(id);
    data.push(movieCardFromDoc(doc, String((pick && pick.reason) || "")));
    if (data.length >= count) break;
  }

  res.json({ ok: true, data });
}

// ===========================================================================
// Endpoint 2 — POST /api/ai/search  ("AI Search")
// Body: { query } → a natural-language query turned into up to 50 real TMDB
// movie objects. Gemini proposes titles+years; we resolve each against TMDB so
// every returned record is genuine.
// ===========================================================================
async function search(req, res) {
  const query = String((req.body && req.body.query) || "").trim();
  if (!query) badRequest("query is required");

  const aiPrompt = [
    "You are a movie search engine. For the request below, list the most",
    `relevant real, existing movies (up to ${MAX_SEARCH_RESULTS}), best match first.`,
    `REQUEST: "${query}"`,
    "Respond with ONLY a JSON array of objects with this exact shape:",
    '[{ "title": "<exact movie title>", "year": "<4-digit release year>" }]',
    "No prose, no markdown, no code fences — just the JSON array.",
  ].join("\n");

  const suggestions = (await generateJsonArray(aiPrompt))
    .filter((s) => s && s.title)
    .slice(0, MAX_SEARCH_RESULTS);

  // Return the raw TMDB record (the client's normaliser handles this shape, same as
  // the movie feed). No `reason` here — AI Search is a results grid, not picks.
  const data = await resolveSuggestions(suggestions, (_rec, movie) => movie);

  res.json({ ok: true, data });
}

// ===========================================================================
// Endpoint 3 — POST /api/ai/enhance/:id  ("Enhance Collection")
// Param: :id (collectionId) → exactly 3 movies NOT already in the collection that
// fit its taste, each with a reason. (Frontend lands later; endpoint ready now.)
// ===========================================================================
async function enhance(req, res) {
  const collection = await loadOwnedCollection(req.params.id, req);
  const movies = await collectionMoviesForAi(collection);

  // Titles already present, so we can ask Gemini to avoid them AND filter any it
  // recommends anyway.
  const existingTitles = new Set(movies.map((m) => m.title.toLowerCase()));
  const existingIds = new Set((collection.items || []).map((it) => it.movieId));

  const aiPrompt = [
    "You are a film recommender. Based on the JSON list of movies a user already",
    `has in their collection, recommend EXACTLY ${ENHANCE_COUNT} real movies they`,
    "would likely enjoy that are NOT already in the list.",
    "Respond with ONLY a JSON array of objects with this exact shape:",
    '[{ "title": "<exact movie title>", "year": "<4-digit release year>", "reason": "<one short sentence>" }]',
    "No prose, no markdown, no code fences — just the JSON array.",
    "",
    "EXISTING COLLECTION:",
    JSON.stringify(movies),
  ].join("\n");

  const suggestions = (await generateJsonArray(aiPrompt))
    .filter((s) => s && s.title && !existingTitles.has(String(s.title).toLowerCase()))
    .slice(0, ENHANCE_COUNT);

  // Resolve to TMDB and attach the AI's reasoning; drop any that collide with a
  // movie already in the collection (the model can suggest one under a variant title).
  let data = await resolveSuggestions(suggestions, (rec, movie) => ({
    ...movie,
    reason: String(rec.reason || ""),
  }));
  data = data.filter((m) => !existingIds.has(m.id));

  res.json({ ok: true, data });
}

module.exports = { picker, search, enhance };
