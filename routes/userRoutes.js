// routes/userRoutes.js — user profile resource. Mounted at /api/users in index.js.
const express = require("express");
const requireAuth = require("../middleware/auth");
const { updateMe } = require("../controllers/userController");

const router = express.Router();

router.patch("/me", requireAuth, updateMe); // PATCH /api/users/me (Bearer)

module.exports = router;
