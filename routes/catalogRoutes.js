// routes/catalogRoutes.js — catalog metadata (genres, providers) for the filters.
// Mounted at /api in index.js, so paths here are relative (final: /api/genres,
// /api/providers).
const express = require("express");
const route = require("../utils/route");
const catalog = require("../controllers/catalogController");

const router = express.Router();

router.get("/genres", route(catalog.genres));
router.get("/providers", route(catalog.providers));

module.exports = router;
