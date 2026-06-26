// controllers/aiController.js — the three Gemini-backed AI features:
// "Let AI Choose", "AI Search", "Enhance Collection".
// Every response uses the contract envelope { ok:true, data } / { ok:false, error };
// handlers are plain async (req, res) wrapped by utils/route() in the routes layer.
//
// Division of labour:
//   • services/gemini.js owns the model config + JSON-mode plumbing.
//   • This file owns the PROMPTS (the strict JSON schema each feature expects) and
//     the mapping of Gemini's answer back onto real data — collection movies for
//     the picker, TMDB records for search/enhance. Gemini only ever ranks/suggests;
//     it never invents the data we return (we re-resolve everything ourselves).

const { SchemaType } = require("@google/generative-ai");
const Movie = require("../models/Movie");
const { tmdb } = require("../services/tmdb");
const { dbReady, retrieveMovie } = require("../services/movieCache");
const { generateJsonArray } = require("../services/gemini");
const { findOr404, assertOwner } = require("./collectionController");
const { aiUsageFor, consumeAiAction, aiLimitError } = require("../services/aiQuota");

// Caps that keep us inside free-tier limits and bound the work per request.
const MAX_PICK = 3; // "Let AI Choose" returns at most this many
const MAX_SEARCH_RESULTS = 50; // "AI Search" resolves at most this many titles
const ENHANCE_COUNT = 3; // "Enhance Collection" returns this many
const MAX_ENHANCE_FETCH = 18; // ceiling on the per-reroll candidate buffer (see enhance)
const TMDB_CONCURRENCY = 6; // parallel TMDB lookups when resolving AI titles

// ---------------------------------------------------------------------------
// Strict response schemas (Gemini responseSchema). These make the JSON shape a hard
// contract enforced by the model, so we no longer rely on the prompt alone to keep
// the output well-formed — a hallucinated/extra field or markdown wrapper can't
// happen. The prompt still owns the CONTENT (what each field should contain).
// ---------------------------------------------------------------------------
const PICKER_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      movieId: { type: SchemaType.INTEGER }, // must echo an id from the provided list
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
      year: { type: SchemaType.STRING }, // 4-digit release year
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
      year: { type: SchemaType.STRING }, // 4-digit release year
      reason: { type: SchemaType.STRING },
    },
    required: ["title", "year", "reason"],
  },
};

// Smart Reroll ("Try Again"): the client sends the ids currently on screen as
// `exclude_ids`. We SOFT-filter them out of the new suggestions, but only while at
// least this many fresh options remain — below the floor we let excluded ids back
// in rather than return empty/short cards (the "crucial fallback").
const MIN_AFTER_EXCLUDE = 3;

// Coerce a client `exclude_ids` payload (array of numbers/numeric strings) into a
// Set<number> of TMDB ids. Tolerates junk: non-numeric entries are dropped, a
// non-array becomes an empty set (the soft filter then simply does nothing).
function parseExcludeIds(raw) {
  const set = new Set();
  if (!Array.isArray(raw)) return set;
  for (const v of raw) {
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n)) set.add(n);
  }
  return set;
}

// Coerce a client `exclude_titles` payload (array of strings — the titles already
// shown this session) into a clean, de-duped string[] for the prompt's "already
// suggested, don't repeat" list. Bounded so a long session can't bloat the prompt.
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

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

// Throw a 400 with `message` (the validation pattern used across controllers).
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// Throw a 429 if the signed-in user has spent all their AI actions for today. Each
// AI feature calls this BEFORE the (slow, quota-limited) Gemini work so an
// over-limit request fails fast; the action itself is only spent — via
// consumeAiAction() — once the work succeeds, so an upstream failure costs nothing.
function assertAiActionAvailable(req) {
  if (aiUsageFor(req.user).remaining <= 0) throw aiLimitError();
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
  const exclude = parseExcludeIds(body.exclude_ids); // Smart Reroll: ids on screen now

  if (!collectionId) badRequest("collectionId is required");
  if (!prompt) badRequest("prompt is required");
  if (!Number.isFinite(count) || count < 1) count = 1;
  count = Math.min(count, MAX_PICK); // hard cap 1..3

  assertAiActionAvailable(req); // daily quota gate (spend happens on success below)

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

  // The PICKER_SCHEMA enforces the [{ movieId, reason }] shape; the prompt owns the
  // CONTENT: the model must echo back movieIds FROM the given list (so we can map
  // them to real movies), each with a one-line reason.
  const aiPrompt = [
    "You are a film curator. From the JSON list of movies below, select EXACTLY",
    `${count} movie(s) that best match this request: "${prompt}".`,
    "Only choose from the provided list — never invent titles.",
    "When several movies fit the request well, vary your selection so repeat",
    `requests surface different good picks. Variation token: ${variationToken}.`,
    // Soft-avoid the on-screen ids so a reroll feels fresh; the post-filter below is
    // the real guard (this just biases the model when there's room to comply).
    exclude.size
      ? `Prefer NOT to pick these movieIds (already shown): ${[...exclude].join(", ")}.`
      : "",
    "For each pick, return its movieId (the id field from the list) and a one-sentence reason.",
    "",
    "MOVIES:",
    JSON.stringify(shuffled),
  ].join("\n");

  // Higher temperature here (vs. the 0.4 default) so the picks aren't locked to the
  // single "most obvious" answer — that's what makes Try Again feel alive.
  const picks = await generateJsonArray(aiPrompt, { temperature: 1.0, schema: PICKER_SCHEMA });

  // Map the AI's ids back to real movie docs, dropping anything not actually in the
  // collection (guards against a hallucinated id). Preserve the AI's ordering.
  const docs = await Movie.find({ _id: { $in: movies.map((m) => m.id) } }).lean();
  const byId = new Map(docs.map((d) => [d._id, d]));

  // De-dupe by id (seen) AND split into fresh vs. on-screen so the soft reroll can
  // prefer fresh picks but still fall back if there aren't enough.
  const seen = new Set();
  const preferred = []; // ids NOT currently on screen
  const fallback = []; // excluded ids, used only to top up to `count`
  for (const pick of picks) {
    const id = Math.trunc(Number(pick && pick.movieId));
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const doc = byId.get(id);
    if (!doc) continue; // not in the collection — ignore (guards hallucinated ids)
    seen.add(id);
    const card = movieCardFromDoc(doc, String((pick && pick.reason) || ""));
    (exclude.has(id) ? fallback : preferred).push(card);
  }

  // Crucial fallback: fill from fresh picks first, then top up with excluded ones
  // only if we'd otherwise come up short — never return empty/short cards just
  // because the best matches happen to be the ones already on screen.
  const data = [...preferred, ...fallback].slice(0, count);

  const aiUsage = await consumeAiAction(req.user); // spend one action (incl. rerolls)
  res.json({ ok: true, data, aiUsage });
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
  assertAiActionAvailable(req); // daily quota gate (spend happens on success below)
  const exclude = parseExcludeIds(req.body && req.body.exclude_ids); // Smart Reroll

  // SEARCH_SCHEMA enforces the [{ title, year }] shape; the prompt owns the content.
  const aiPrompt = [
    "You are a movie search engine. For the request below, list the most",
    `relevant real, existing movies (up to ${MAX_SEARCH_RESULTS}), best match first.`,
    `REQUEST: "${query}"`,
    "For each, give the exact movie title and its 4-digit release year.",
  ].join("\n");

  const suggestions = (await generateJsonArray(aiPrompt, { schema: SEARCH_SCHEMA }))
    .filter((s) => s && s.title)
    .slice(0, MAX_SEARCH_RESULTS);

  // Return the raw TMDB record (the client's normaliser handles this shape, same as
  // the movie feed). No `reason` here — AI Search is a results grid, not picks.
  // resolveSuggestions already de-dupes by TMDB id.
  const resolved = await resolveSuggestions(suggestions, (_rec, movie) => movie);

  // Smart Reroll soft filter: drop ids already on screen, but fall back to the full
  // set if doing so would leave too few results (the "crucial fallback").
  const fresh = resolved.filter((m) => !exclude.has(m.id));
  const data = fresh.length >= MIN_AFTER_EXCLUDE ? fresh : resolved;

  const aiUsage = await consumeAiAction(req.user); // spend one action (incl. rerolls)
  res.json({ ok: true, data, aiUsage });
}

// ===========================================================================
// Endpoint 3 — POST /api/ai/enhance/:id  ("Enhance Collection")
// Param: :id (collectionId). Body: { exclude_ids?, exclude_titles? } — everything
// already shown this session (ids = hard filter, titles = prompt avoidance) so a
// "Try Again" reroll never repeats. → up to ENHANCE_COUNT movies NOT already in the
// collection that fit its taste, each with a reason. Warms the movie cache with the
// full details of whatever it returns.
// ===========================================================================
async function enhance(req, res) {
  assertAiActionAvailable(req); // daily quota gate (spend happens on success below)
  // "Try Again" sends the FULL set of everything offered this session: ids (for the
  // hard post-filter) AND titles (for the prompt). Gemini invents titles, so naming
  // them in the prompt is the ONLY way to actually stop it repeating — and the
  // resolved movies are never written to the Movie cache, so the client (which
  // showed them) is the only place those titles exist. That's why it sends them.
  const exclude = parseExcludeIds(req.body && req.body.exclude_ids);
  const excludeTitles = parseTitleList(req.body && req.body.exclude_titles);
  const collection = await loadOwnedCollection(req.params.id, req);
  const movies = await collectionMoviesForAi(collection);

  const existingTitles = new Set(movies.map((m) => m.title.toLowerCase()));
  const existingIds = new Set((collection.items || []).map((it) => it.movieId));

  // The collection's NAME often signals its intent (e.g. "Cozy Rainy Day", "90s
  // Action") — feed it to the model so picks fit the theme, not just the titles.
  const collectionName = String(collection.name || "").replace(/\s+/g, " ").trim().slice(0, 100);

  // A one-off variation token + a higher temperature break the determinism that
  // would otherwise return the same picks every press (same trick the picker uses).
  const variationToken = Math.random().toString(36).slice(2, 10);

  // Buffer = how many we must avoid + how many we return. Asking for this many means
  // that EVEN IF the model ignores the avoid-list and re-suggests every excluded
  // title, ENHANCE_COUNT genuinely-new ones still survive the hard filter — so a
  // reroll can never come up short because of repeats. Capped for sanity (the
  // title-avoidance + hard filter still prevent repeats beyond the cap; we might
  // just return fewer than 3 once the AI truly runs dry). Best-recommendation first,
  // so after filtering we keep the top picks.
  const fetchCount = Math.min(exclude.size + ENHANCE_COUNT, MAX_ENHANCE_FETCH);

  // ENHANCE_SCHEMA enforces the [{ title, year, reason }] shape; the prompt owns the content.
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

  // Higher temperature (vs. the 0.4 default) so a reroll isn't locked to the single
  // "most obvious" set — that's what makes Try Again feel alive.
  const suggestions = (await generateJsonArray(aiPrompt, { temperature: 1.0, schema: ENHANCE_SCHEMA }))
    .filter((s) => s && s.title && !existingTitles.has(String(s.title).toLowerCase()))
    .slice(0, fetchCount);

  // Resolve each title → a real TMDB id (search), keeping the AI's order + reason.
  const resolved = await resolveSuggestions(suggestions, (rec, movie) => ({
    id: movie.id,
    reason: String(rec.reason || ""),
  }));

  // HARD filter (no fallback): never a movie already in the collection OR already
  // shown this session. Take the top ENHANCE_COUNT — they're in recommendation order.
  const picks = resolved
    .filter((m) => !existingIds.has(m.id) && !exclude.has(m.id))
    .slice(0, ENHANCE_COUNT);

  // Warm the DB: fetch full details for the ones we'll show (a Mongo hit means no
  // TMDB call) and store them forever, then build each card from the cached movie.
  // One bad lookup just drops that card rather than failing the whole batch.
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
        return null; // dead id / upstream blip — drop this one
      }
    })
  );
  const data = cards.filter(Boolean);

  const aiUsage = await consumeAiAction(req.user); // spend one action (incl. Try Again)
  res.json({ ok: true, data, aiUsage });
}

// ===========================================================================
// Endpoint 4 — GET /api/ai/usage  (daily quota status)
// The client reads this to render the "AI Actions remaining" line in the header
// menu and to refresh it after each action. Pure read (applies the lazy reset).
// ===========================================================================
async function getUsage(req, res) {
  res.json({ ok: true, data: aiUsageFor(req.user) });
}

module.exports = { picker, search, enhance, getUsage };
