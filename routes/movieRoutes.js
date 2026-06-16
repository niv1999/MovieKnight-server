// routes/movieRoutes.js — /api/movies
const express = require("express");
const router = express.Router();
const { search, getById } = require("../controllers/movieController");

router.get("/search", search);
router.get("/:tmdbId", getById);

module.exports = router;
