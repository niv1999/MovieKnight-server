// routes/aiRoutes.js — Gemini-backed AI features. Mounted at /api/ai in index.js,
// so paths here are relative to that prefix (final paths are /api/ai/*).
// All three are login-gated (requireAuth): the picker + enhance act on a user's own
// collection (owner enforced in the controller), and AI Search is a logged-in-only
// feature that spends our shared Gemini quota.
const express = require("express");
const route = require("../utils/route");
const requireAuth = require("../middleware/auth");
const ai = require("../controllers/aiController");

const router = express.Router();

router.post("/picker", requireAuth, route(ai.picker)); //   "Let AI Choose"
router.post("/search", requireAuth, route(ai.search)); //   "AI Search"
router.post("/enhance/:id", requireAuth, route(ai.enhance)); // "Enhance Collection"

// AI Picker session save/load (one active session per user, stored on the user doc).
router.get("/session", requireAuth, route(ai.getSession));
router.put("/session", requireAuth, route(ai.saveSession));

module.exports = router;
