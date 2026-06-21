// routes/collectionRoutes.js — Collections resource. Mounted at /api in index.js,
// so paths here are relative to that prefix (final paths are /api/collections/*).
// Owner-only routes go through requireAuth; GET /:id uses optionalAuth so a guest
// (or another user) can view a PUBLIC collection in visitor mode while a private
// one stays 404 to everyone but its owner (enforced in the controller).
const express = require("express");
const route = require("../utils/route");
const requireAuth = require("../middleware/auth");
const collections = require("../controllers/collectionController");

const router = express.Router();

router.get("/collections", requireAuth, route(collections.listMine)); // mine
router.post("/collections", requireAuth, route(collections.create));

// Viewing a collection is login-gated (Explore is logged-in only): guests get 401
// (the client redirects them to login). A logged-in non-owner sees a PUBLIC
// collection in visitor mode; a private one stays 404.
router.get("/collections/:id", requireAuth, route(collections.getOne));
router.patch("/collections/:id", requireAuth, route(collections.update)); // rename / publish
router.delete("/collections/:id", requireAuth, route(collections.remove));

router.post("/collections/:id/movies", requireAuth, route(collections.addMovie));
router.delete(
  "/collections/:id/movies/:tmdbId",
  requireAuth,
  route(collections.removeMovie)
);

// Spin the Wheel persistence. GET is viewable (owner or a PUBLIC collection); PUT
// is owner-only (enforced in the controller).
router.get("/collections/:id/wheel", requireAuth, route(collections.getWheel));
router.put("/collections/:id/wheel", requireAuth, route(collections.saveWheel));
// Distinct genre/provider facet ids present in this collection (for the wheel's
// filter chips). Pure DB read — no TMDB. Literal sub-path, no param clash.
router.get("/collections/:id/wheel/filters", requireAuth, route(collections.wheelFilters));

module.exports = router;
