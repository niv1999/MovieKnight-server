const express = require("express");
const requireAuth = require("../middleware/auth");
const { updateMe } = require("../controllers/userController");

const router = express.Router();

router.patch("/me", requireAuth, updateMe);

module.exports = router;
