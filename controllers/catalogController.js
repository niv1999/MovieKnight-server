// genre + US provider lists, memoized in-process so it works without Mongo
const { tmdb } = require("../services/tmdb");

const CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const memo = { genres: null, providers: null };

async function cached(slot, fetcher) {
  const hit = memo[slot];
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const data = await fetcher();
  // never cache empty so an upstream blip can't pin "no results"
  if (Array.isArray(data) && data.length) {
    memo[slot] = { data, expiresAt: Date.now() + CATALOG_TTL_MS };
  }
  return data;
}

async function genres(req, res) {
  const data = await cached("genres", async () => {
    const tmdbData = await tmdb("/genre/movie/list");
    return tmdbData.genres || [];
  });
  res.json({ ok: true, data });
}

// trim the bulky display_priorities map down to fields the frontend uses
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
