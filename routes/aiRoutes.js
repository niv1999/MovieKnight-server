// /api/ai. login-gated: acts on the user's own data or spends shared quota.
const express = require("express");
const route = require("../utils/route");
const requireAuth = require("../middleware/auth");
const ai = require("../controllers/aiController");

const router = express.Router();

router.post("/picker", requireAuth, route(ai.picker));
router.post("/search", requireAuth, route(ai.search));
router.post("/enhance/:id", requireAuth, route(ai.enhance));
router.get("/usage", requireAuth, route(ai.getUsage));

module.exports = router;
