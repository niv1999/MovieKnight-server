const express = require("express");
const route = require("../utils/route");
const catalog = require("../controllers/catalogController");

const router = express.Router();

router.get("/genres", route(catalog.genres));
router.get("/providers", route(catalog.providers));

module.exports = router;
