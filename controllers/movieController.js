// controllers/movieController.js
// STUB movies so the client can build against it (task S1).
// Replaced by the TMDB proxy (S2) + Mongo cache + search query (S6).

const STUB = [
  { tmdbId: 27205, title: "Inception", releaseYear: 2010, rating: 8.4, posterPath: null },
  { tmdbId: 157336, title: "Interstellar", releaseYear: 2014, rating: 8.5, posterPath: null },
  { tmdbId: 155, title: "The Dark Knight", releaseYear: 2008, rating: 8.5, posterPath: null },
];

function search(req, res) {
  const q = (req.query.q || "").toLowerCase();
  const data = q ? STUB.filter((m) => m.title.toLowerCase().includes(q)) : STUB;
  res.json({ ok: true, data });
}

function getById(req, res) {
  const movie = STUB.find((m) => String(m.tmdbId) === req.params.tmdbId);
  if (!movie) return res.status(404).json({ ok: false, error: "Movie not found" });
  res.json({ ok: true, data: movie });
}

module.exports = { search, getById };
