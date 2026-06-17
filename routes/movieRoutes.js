// routes/movieRoutes.js — /api/movies
const express = require("express");
const router = express.Router();
const { search, getById } = require("../controllers/movieController");
const { wheel } = require("../controllers/wheelController");

router.get("/search", search);
// Must come before "/:tmdbId" so "wheel" isn't parsed as a movie id.
router.get("/wheel", wheel);
router.get("/:tmdbId", getById);

module.exports = router;
