// AI features: gemini ranks/suggests, we re-resolve everything against real data.

const { SchemaType } = require("@google/generative-ai");
const Movie = require("../models/Movie");
const { tmdb } = require("../services/tmdb");
const { dbReady, retrieveMovie } = require("../services/movieCache");
const { generateJsonArray } = require("../services/gemini");
const { findOr404, assertOwner } = require("./collectionController");
const { aiUsageFor, consumeAiAction, aiLimitError } = require("../services/aiQuota");

const MAX_PICK = 3;
const MAX_SEARCH_RESULTS = 50;
const ENHANCE_COUNT = 3;
const MAX_ENHANCE_FETCH = 18; // ceiling on the per-reroll candidate buffer (see enhance)
const TMDB_CONCURRENCY = 6;

const PICKER_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      movieId: { type: SchemaType.INTEGER },
      reason: { type: SchemaType.STRING },
    },
    required: ["movieId", "reason"],
  },
};
const SEARCH_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },
      year: { type: SchemaType.STRING },
    },
    required: ["title", "year"],
  },
};
const ENHANCE_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },
      year: { type: SchemaType.STRING },
      reason: { type: SchemaType.STRING },
    },
    required: ["title", "year", "reason"],
  },
};

// reroll soft-filter floor: below this many fresh options we let excluded ids back in
const MIN_AFTER_EXCLUDE = 3;

function parseExcludeIds(raw) {
  const set = new Set();
  if (!Array.isArray(raw)) return set;
  for (const v of raw) {
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n)) set.add(n);
  }
  return set;
}

function parseTitleList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const t = String(v || "").trim();
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out.slice(0, 100);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// throw 429 before the gemini work; the action is only spent on success
function assertAiActionAvailable(req) {
  if (aiUsageFor(req.user).remaining <= 0) throw aiLimitError();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadOwnedCollection(id, req) {
  const collection = await findOr404(id);
  assertOwner(collection, req);
  return collection;
}

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
      id: d._id, // the "movieId" gemini must echo back
      title: d.title,
      year: d.releaseYear || null,
      genres: d.genres || [],
    }));
}

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

// resolve { title, year } to a real TMDB record; prefers exact-year match, else top
// hit. returns null on miss/error so one bad lookup can't sink the batch.
async function findTmdbMovie(title, year) {
  const q = String(title || "").trim();
  if (!q) return null;
  try {
    const params = { query: q, include_adult: "false" };
    const y = parseInt(String(year || "").slice(0, 4), 10);
    if (Number.isFinite(y)) params.year = y;
    const data = await tmdb("/search/movie", params);
    const results = data.results || [];
    if (!results.length) return null;
    if (Number.isFinite(y)) {
      const exact = results.find(
        (m) => String(m.release_date || "").slice(0, 4) === String(y)
      );
      if (exact) return exact;
    }
    return results[0];
  } catch (_) {
    return null;
  }
}

// resolve suggestions to TMDB records with a concurrency cap, preserving order and
// dropping misses. attach(rec, movie) shapes each kept hit.
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

  // de-dupe by id (AI lists can repeat a title), keeping order
  const seen = new Set();
  const deduped = [];
  for (const m of out) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push(m);
  }
  return deduped;
}

// POST /api/ai/picker: pick `count` movies from the user's collection matching `prompt`
async function picker(req, res) {
  const body = req.body || {};
  const collectionId = String(body.collectionId || "").trim();
  const prompt = String(body.prompt || "").trim();
  let count = Math.trunc(Number(body.count));
  const exclude = parseExcludeIds(body.exclude_ids); // ids on screen now

  if (!collectionId) badRequest("collectionId is required");
  if (!prompt) badRequest("prompt is required");
  if (!Number.isFinite(count) || count < 1) count = 1;
  count = Math.min(count, MAX_PICK);

  assertAiActionAvailable(req);

  const collection = await loadOwnedCollection(collectionId, req);
  const movies = await collectionMoviesForAi(collection);
  if (!movies.length) {
    badRequest("This collection has no movies to choose from");
  }
  count = Math.min(count, movies.length);

  // Try Again sends the same body; shuffle + variation token + higher temp break
  // otherwise-identical picks across rerolls.
  const shuffled = shuffle(movies);
  const variationToken = Math.random().toString(36).slice(2, 10);

  const aiPrompt = [
    "You are a film curator. From the JSON list of movies below, select EXACTLY",
    `${count} movie(s) that best match this request: "${prompt}".`,
    "Only choose from the provided list — never invent titles.",
    "When several movies fit the request well, vary your selection so repeat",
    `requests surface different good picks. Variation token: ${variationToken}.`,
    // soft-avoid on-screen ids; the post-filter below is the real guard
    exclude.size
      ? `Prefer NOT to pick these movieIds (already shown): ${[...exclude].join(", ")}.`
      : "",
    "For each pick, return its movieId (the id field from the list) and a one-sentence reason.",
    "",
    "MOVIES:",
    JSON.stringify(shuffled),
  ].join("\n");

  const picks = await generateJsonArray(aiPrompt, { temperature: 1.0, schema: PICKER_SCHEMA });

  const docs = await Movie.find({ _id: { $in: movies.map((m) => m.id) } }).lean();
  const byId = new Map(docs.map((d) => [d._id, d]));

  // split fresh vs on-screen so the soft reroll prefers fresh picks
  const seen = new Set();
  const preferred = [];
  const fallback = []; // excluded ids, used only to top up to `count`
  for (const pick of picks) {
    const id = Math.trunc(Number(pick && pick.movieId));
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const doc = byId.get(id);
    if (!doc) continue; // guards hallucinated ids
    seen.add(id);
    const card = movieCardFromDoc(doc, String((pick && pick.reason) || ""));
    (exclude.has(id) ? fallback : preferred).push(card);
  }

  // fresh first, top up with excluded only if short, so a reroll never comes up empty
  const data = [...preferred, ...fallback].slice(0, count);

  const aiUsage = await consumeAiAction(req.user);
  res.json({ ok: true, data, aiUsage });
}

// POST /api/ai/search: natural-language query into up to 50 real TMDB movie objects
async function search(req, res) {
  const query = String((req.body && req.body.query) || "").trim();
  if (!query) badRequest("query is required");
  assertAiActionAvailable(req);
  const exclude = parseExcludeIds(req.body && req.body.exclude_ids);

  const aiPrompt = [
    "You are a movie search engine. For the request below, list the most",
    `relevant real, existing movies (up to ${MAX_SEARCH_RESULTS}), best match first.`,
    `REQUEST: "${query}"`,
    "For each, give the exact movie title and its 4-digit release year.",
  ].join("\n");

  const suggestions = (await generateJsonArray(aiPrompt, { schema: SEARCH_SCHEMA }))
    .filter((s) => s && s.title)
    .slice(0, MAX_SEARCH_RESULTS);

  const resolved = await resolveSuggestions(suggestions, (_rec, movie) => movie);

  // soft filter on-screen ids, fall back to full set if too few would remain
  const fresh = resolved.filter((m) => !exclude.has(m.id));
  const data = fresh.length >= MIN_AFTER_EXCLUDE ? fresh : resolved;

  const aiUsage = await consumeAiAction(req.user);
  res.json({ ok: true, data, aiUsage });
}

// POST /api/ai/enhance/:id: up to ENHANCE_COUNT movies NOT in the collection that fit
// its taste, each with a reason. warms the movie cache with the full details returned.
async function enhance(req, res) {
  assertAiActionAvailable(req);
  // ids = hard post-filter, titles = prompt avoidance. gemini invents titles, so
  // naming them in the prompt is the only way to stop it repeating across rerolls.
  const exclude = parseExcludeIds(req.body && req.body.exclude_ids);
  const excludeTitles = parseTitleList(req.body && req.body.exclude_titles);
  const collection = await loadOwnedCollection(req.params.id, req);
  const movies = await collectionMoviesForAi(collection);

  const existingTitles = new Set(movies.map((m) => m.title.toLowerCase()));
  const existingIds = new Set((collection.items || []).map((it) => it.movieId));

  // collection name often signals intent, feed it to the model so picks fit the theme
  const collectionName = String(collection.name || "").replace(/\s+/g, " ").trim().slice(0, 100);

  const variationToken = Math.random().toString(36).slice(2, 10);

  // buffer = #avoid + #return, so even if the model re-suggests every excluded title,
  // ENHANCE_COUNT genuinely-new ones survive the hard filter. capped for sanity.
  const fetchCount = Math.min(exclude.size + ENHANCE_COUNT, MAX_ENHANCE_FETCH);

  const aiPrompt = [
    "You are a film recommender. Based on the JSON list of movies a user already",
    `has in their collection, recommend ${fetchCount} real movies they would enjoy`,
    "that are NOT already in the list, ordered best-recommendation first.",
    collectionName
      ? `The collection is called "${collectionName}" — might indicate a certain theme/intent that could guide your picks.`
      : "",
    "For each, give the exact movie title, its 4-digit release year, and a one-sentence reason they'd enjoy it.",
    `Make them varied. Variation token: ${variationToken}.`,
    excludeTitles.length
      ? `These have ALREADY been suggested to this user — every recommendation MUST be new, so do NOT include ANY of these: ${excludeTitles.join("; ")}.`
      : "",
    "",
    "EXISTING COLLECTION:",
    JSON.stringify(movies),
  ].join("\n");

  const suggestions = (await generateJsonArray(aiPrompt, { temperature: 1.0, schema: ENHANCE_SCHEMA }))
    .filter((s) => s && s.title && !existingTitles.has(String(s.title).toLowerCase()))
    .slice(0, fetchCount);

  const resolved = await resolveSuggestions(suggestions, (rec, movie) => ({
    id: movie.id,
    reason: String(rec.reason || ""),
  }));

  // hard filter, no fallback: never already in the collection or shown this session
  const picks = resolved
    .filter((m) => !existingIds.has(m.id) && !exclude.has(m.id))
    .slice(0, ENHANCE_COUNT);

  // warm the cache via retrieveMovie; one bad lookup drops that card, not the batch
  const cards = await Promise.all(
    picks.map(async ({ id, reason }) => {
      try {
        const m = await retrieveMovie(id);
        return {
          id: m.id,
          title: m.title,
          poster_path: m.poster_path,
          vote_average: m.vote_average,
          release_date: m.release_date,
          reason,
        };
      } catch (_) {
        return null;
      }
    })
  );
  const data = cards.filter(Boolean);

  const aiUsage = await consumeAiAction(req.user);
  res.json({ ok: true, data, aiUsage });
}

// GET /api/ai/usage daily quota status
async function getUsage(req, res) {
  res.json({ ok: true, data: aiUsageFor(req.user) });
}

module.exports = { picker, search, enhance, getUsage };
