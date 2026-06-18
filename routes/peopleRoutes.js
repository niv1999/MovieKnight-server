// routes/peopleRoutes.js — people lookups for the Actor/Director filter.
// Mounted at the app root; routes carry their full /api/people path.
const express = require("express");
const route = require("../utils/route");
const people = require("../controllers/peopleController");

const router = express.Router();

router.get("/api/people/search", route(people.search));
router.get("/api/people/popular", route(people.popular));

module.exports = router;
