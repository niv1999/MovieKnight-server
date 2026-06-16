// routes/collectionRoutes.js — /api/collections
const express = require("express");
const router = express.Router();
const c = require("../controllers/collectionController");

router.get("/", c.list);
router.post("/", c.create);
router.get("/:id", c.getOne);
router.patch("/:id", c.update);
router.delete("/:id", c.remove);

router.post("/:id/movies", c.addMovie);
router.delete("/:id/movies/:tmdbId", c.removeMovie);

router.get("/:id/wheel", c.getWheel);
router.put("/:id/wheel", c.saveWheel);

module.exports = router;
