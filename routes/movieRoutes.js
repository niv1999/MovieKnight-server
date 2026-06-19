// routes/movieRoutes.js — movie endpoints. Mounted at /api in index.js, so paths
// here are relative to that prefix (final paths are /api/movies/*).
const express = require("express");
const route = require("../utils/route");
const movies = require("../controllers/movieController");

const router = express.Router();

// search + random are declared before :id so those literal paths aren't
// swallowed by the :id param.
router.get("/movies/search", route(movies.search));
router.get("/movies/random", route(movies.random));
router.get("/movies/cache-stats", route(movies.cacheStats));
router.get("/movies/:id", route(movies.details));

module.exports = router;
