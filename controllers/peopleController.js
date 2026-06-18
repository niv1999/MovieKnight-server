// controllers/peopleController.js — people (actors/directors) lookups that power
// the Actor/Director filter. Both return the /api contract envelope { ok, data }.
const { tmdb, clampPage } = require("../services/tmdb");

// Trim a TMDB person to the shape both people routes return.
const mapPerson = (p) => ({
  id: p.id,
  name: p.name,
  profile_path: p.profile_path,
  known_for_department: p.known_for_department,
});

// TMDB's /person/popular is global (and `language=` only translates fields — it
// doesn't regionalize the ranking, and there's no region param). To bias toward
// US/Hollywood names we keep people whose `known_for` titles are mostly English.
const PEOPLE_POPULAR_SOURCE_PAGES = 3; // pulled per response so ~20 remain after filtering
const isMostlyEnglish = (p) => {
  const langs = (p.known_for || []).map((k) => k.original_language).filter(Boolean);
  if (langs.length === 0) return false;
  const english = langs.filter((l) => l === "en").length;
  return english / langs.length >= 0.5;
};

// GET /api/people/search?q=<text> — search TMDB people (actors/directors) for the
// filters. Accepts `q` (or legacy `query`). `known_for_department` ("Acting" /
// "Directing") helps the UI tell them apart. Empty query -> data: [].
async function search(req, res) {
  const query = String(req.query.q || req.query.query || "").trim();
  if (!query) {
    return res.json({ ok: true, data: [] });
  }
  const tmdbData = await tmdb("/search/person", { query, include_adult: "false" });
  res.json({ ok: true, data: (tmdbData.results || []).map(mapPerson) });
}

// GET /api/people/popular — popular (English-biased) people to pre-fill the
// actor/director dropdowns before the user types. Same item shape as
// /api/people/search. Accepts ?page.
async function popular(req, res) {
  const page = clampPage(req.query.page);
  // Pull a window of source pages so enough English-known people survive the filter.
  const startPage = (page - 1) * PEOPLE_POPULAR_SOURCE_PAGES + 1;
  const pages = await Promise.all(
    Array.from({ length: PEOPLE_POPULAR_SOURCE_PAGES }, (_, i) =>
      tmdb("/person/popular", { page: startPage + i })
    )
  );

  let people = [];
  for (const pg of pages) people = people.concat(pg.results || []);
  const data = people.filter(isMostlyEnglish).slice(0, 20).map(mapPerson);
  res.json({ ok: true, data });
}

module.exports = { search, popular };
