// routes/catalogRoutes.js — catalog metadata (genres, providers) for the filters.
// Mounted at the app root; routes carry their full /api path.
const express = require("express");
const route = require("../utils/route");
const catalog = require("../controllers/catalogController");

const router = express.Router();

router.get("/api/genres", route(catalog.genres));
router.get("/api/providers", route(catalog.providers));

module.exports = router;
