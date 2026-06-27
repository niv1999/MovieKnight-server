// all routes requireAuth. non-owner can view PUBLIC collections; private stays 404 (controller-enforced).
const express = require("express");
const route = require("../utils/route");
const requireAuth = require("../middleware/auth");
const collections = require("../controllers/collectionController");

const router = express.Router();

router.get("/collections", requireAuth, route(collections.listMine));
router.post("/collections", requireAuth, route(collections.create));

router.get("/collections/:id", requireAuth, route(collections.getOne));
router.patch("/collections/:id", requireAuth, route(collections.update));
router.delete("/collections/:id", requireAuth, route(collections.remove));

router.post("/collections/:id/movies", requireAuth, route(collections.addMovie));
router.delete(
  "/collections/:id/movies/:tmdbId",
  requireAuth,
  route(collections.removeMovie)
);

// wheel: GET viewable by owner or PUBLIC; PUT owner-only.
router.get("/collections/:id/wheel", requireAuth, route(collections.getWheel));
router.put("/collections/:id/wheel", requireAuth, route(collections.saveWheel));
router.get("/collections/:id/wheel/filters", requireAuth, route(collections.wheelFilters));

module.exports = router;
