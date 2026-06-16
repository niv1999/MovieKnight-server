// controllers/collectionController.js
// STUB collections so the client can build against it (task S1).
// Replaced by Mongo CRUD (S5) + collection-with-movies aggregation (S6).

const STUB = [
  { id: "1", name: "Favorites", isDefault: true, isPublic: false, items: [] },
  { id: "2", name: "Already Watched", isDefault: true, isPublic: false, items: [] },
  { id: "3", name: "Watchlist", isDefault: true, isPublic: false, items: [] },
];

const send = (res, data, status = 200) =>
  res.status(status).json({ ok: true, data });

function list(req, res) {
  send(res, STUB);
}

function create(req, res) {
  send(res, { id: "new", name: req.body?.name || "My Collection", items: [] }, 201);
}

function getOne(req, res) {
  const col = STUB.find((c) => c.id === req.params.id);
  if (!col) return res.status(404).json({ ok: false, error: "Collection not found" });
  send(res, { ...col, movies: [] });
}

function update(req, res) {
  send(res, { id: req.params.id, ...req.body });
}

function remove(req, res) {
  send(res, { id: req.params.id, deleted: true });
}

function addMovie(req, res) {
  send(res, { id: req.params.id, added: req.body?.tmdbId });
}

function removeMovie(req, res) {
  send(res, { id: req.params.id, removed: req.params.tmdbId });
}

function getWheel(req, res) {
  send(res, { wheelConfig: [] });
}

function saveWheel(req, res) {
  send(res, { saved: true });
}

module.exports = {
  list,
  create,
  getOne,
  update,
  remove,
  addMovie,
  removeMovie,
  getWheel,
  saveWheel,
};
