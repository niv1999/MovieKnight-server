// routes/authRoutes.js — auth endpoints. Mounted at /api/auth in index.js.
const express = require("express");
const { signup, login, me } = require("../controllers/authController");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.post("/signup", signup); // POST /api/auth/signup
router.post("/login", login); //  POST /api/auth/login
router.get("/me", requireAuth, me); // GET /api/auth/me (Bearer)

module.exports = router;
