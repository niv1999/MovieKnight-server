// routes/movieRoutes.js — movie endpoints. Mounted at the app root so each route
// keeps its full /api/movies path.
const express = require("express");
const route = require("../utils/route");
const movies = require("../controllers/movieController");

const router = express.Router();

// search + random are declared before :id so those literal paths aren't
// swallowed by the :id param.
router.get("/api/movies/search", route(movies.search));
router.get("/api/movies/random", route(movies.random));
router.get("/api/movies/cache-stats", route(movies.cacheStats));
router.get("/api/movies/:id", route(movies.details));

module.exports = router;
