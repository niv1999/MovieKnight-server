const express = require("express");
const route = require("../utils/route");
const movies = require("../controllers/movieController");

const router = express.Router();

// literal paths before :id so :id doesn't swallow them
router.get("/movies/search", route(movies.search));
router.get("/movies/random", route(movies.random));
router.get("/movies/cache-stats", route(movies.cacheStats));
router.get("/movies/:id", route(movies.details));

module.exports = router;
