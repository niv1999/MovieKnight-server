// routes/peopleRoutes.js — people lookups for the Actor/Director filter.
// Mounted at /api in index.js, so paths here are relative (final: /api/people/*).
const express = require("express");
const route = require("../utils/route");
const people = require("../controllers/peopleController");

const router = express.Router();

router.get("/people/search", route(people.search));
router.get("/people/popular", route(people.popular));

module.exports = router;
