// controllers/catalogController.js — catalog metadata used by the filters:
// movie genres and US watch/streaming providers. Both return the /api contract
// envelope { ok:true, data }.
const { tmdb } = require("../services/tmdb");

// GET /api/genres — movie genre list. data = [{ id, name }].
async function genres(req, res) {
  const data = await tmdb("/genre/movie/list");
  res.json({ ok: true, data: data.genres || [] });
}

// GET /api/providers — US watch/streaming providers. TMDB items include a large
// per-country `display_priorities` map; trim to the fields the frontend uses and
// keep `provider_id` (needed to filter via with_watch_providers).
async function providers(req, res) {
  const tmdbData = await tmdb("/watch/providers/movie", { watch_region: "US" });
  const data = (tmdbData.results || []).map((p) => ({
    provider_id: p.provider_id,
    provider_name: p.provider_name,
    logo_path: p.logo_path,
    display_priority: p.display_priority,
  }));
  res.json({ ok: true, data });
}

module.exports = { genres, providers };
