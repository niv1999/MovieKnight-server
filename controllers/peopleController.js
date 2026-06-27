const { tmdb, clampPage } = require("../services/tmdb");

const mapPerson = (p) => ({
  id: p.id,
  name: p.name,
  profile_path: p.profile_path,
  known_for_department: p.known_for_department,
});

// /person/popular has no region param, so bias toward US names by keeping people
// whose known_for titles are mostly english
const PEOPLE_POPULAR_SOURCE_PAGES = 3;
const isMostlyEnglish = (p) => {
  const langs = (p.known_for || []).map((k) => k.original_language).filter(Boolean);
  if (langs.length === 0) return false;
  const english = langs.filter((l) => l === "en").length;
  return english / langs.length >= 0.5;
};

async function search(req, res) {
  const query = String(req.query.q || "").trim();
  if (!query) {
    return res.json({ ok: true, data: [] });
  }
  const tmdbData = await tmdb("/search/person", { query, include_adult: "false" });
  res.json({ ok: true, data: (tmdbData.results || []).map(mapPerson) });
}

async function popular(req, res) {
  const page = clampPage(req.query.page);
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
