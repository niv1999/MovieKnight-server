// controllers/catalogController.js — catalog metadata used by the filters:
// movie genres and US watch/streaming providers. Both return the /api contract
// envelope { ok:true, data }.
//
// Both lists are tiny, identical for every user, and change ~never, so each is
// memoized in process RAM for 30 days instead of re-hitting TMDB on every
// filter-dropdown load (see `cached` below). We deliberately DON'T use Mongo: the
// data is two small static arrays, the miss penalty is a single cheap TMDB call,
// and an in-memory memo keeps working even when MONGODB_URI is unset (per
// CLAUDE.md, the proxy must boot with an empty .env).
const { tmdb } = require("../services/tmdb");

// --- in-memory catalog cache ---------------------------------------------------
//
// Caveats (all acceptable here): the cache is PER-PROCESS, so it starts empty
// after every restart/redeploy — and on Render's Free tier, after each idle
// spin-down — costing exactly one re-fetch to refill. Empty results are NEVER
// cached, so a transient upstream blip can't pin "no genres" for 30 days. A fetch
// error isn't caught here; it propagates to the route's error funnel
// (utils/route), and nothing is cached on failure.
const CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const memo = { genres: null, providers: null }; // slot -> { data, expiresAt }

// Return the memoized array for `slot` while still fresh; otherwise run `fetcher`,
// cache a NON-EMPTY result under the TTL, and return it.
async function cached(slot, fetcher) {
  const hit = memo[slot];
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const data = await fetcher();
  if (Array.isArray(data) && data.length) {
    memo[slot] = { data, expiresAt: Date.now() + CATALOG_TTL_MS };
  }
  return data;
}

// GET /api/genres — movie genre list. data = [{ id, name }].
async function genres(req, res) {
  const data = await cached("genres", async () => {
    const tmdbData = await tmdb("/genre/movie/list");
    return tmdbData.genres || [];
  });
  res.json({ ok: true, data });
}

// GET /api/providers — US watch/streaming providers. TMDB items include a large
// per-country `display_priorities` map; trim to the fields the frontend uses and
// keep `provider_id` (needed to filter via with_watch_providers).
async function providers(req, res) {
  const data = await cached("providers", async () => {
    const tmdbData = await tmdb("/watch/providers/movie", { watch_region: "US" });
    return (tmdbData.results || []).map((p) => ({
      provider_id: p.provider_id,
      provider_name: p.provider_name,
      logo_path: p.logo_path,
      display_priority: p.display_priority,
    }));
  });
  res.json({ ok: true, data });
}

module.exports = { genres, providers };
