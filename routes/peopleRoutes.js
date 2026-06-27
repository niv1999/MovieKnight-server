const express = require("express");
const route = require("../utils/route");
const people = require("../controllers/peopleController");

const router = express.Router();

router.get("/people/search", route(people.search));
router.get("/people/popular", route(people.popular));

module.exports = router;
