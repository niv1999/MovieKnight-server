// routes/authRoutes.js — /api/auth
const express = require("express");
const router = express.Router();
const { signup, login, me } = require("../controllers/authController");

router.post("/signup", signup);
router.post("/login", login);
router.get("/me", me);

module.exports = router;
