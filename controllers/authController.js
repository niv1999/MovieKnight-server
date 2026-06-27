// controllers/authController.js — S4 auth (signup / login / me).
// Passwords are hashed with bcryptjs; sessions are stateless 7-day JWTs the client
// stores in localStorage. Every response uses the contract envelope
// { ok:true, data } / { ok:false, error }.
// passwordHash is NEVER returned to the client.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Collection = require("../models/Collection");
const { aiUsageFor } = require("../services/aiQuota");

const BCRYPT_ROUNDS = 10;
const TOKEN_TTL = "7d";

// Every new user starts with these three collections (stored with isDefault: true).
const DEFAULT_COLLECTIONS = ["Favorites", "Already Watched", "Watchlist"];

// Shape a User doc for the client — explicit allow-list so passwordHash (or any
// future sensitive field) can never leak. Works on a Mongoose doc or a lean object.
function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    name: user.name || "",
    bio: user.bio || "",
    dateOfBirth: user.dateOfBirth || null,
    avatarUrl: user.avatarUrl || null,
    countryCode: user.countryCode || null,
    badges: Array.isArray(user.badges) ? user.badges : [],
    // Daily AI quota ({ used, remaining, limit }) so login/signup/me carry it and
    // the header menu can render the badge from the cached user (no extra request).
    aiUsage: aiUsageFor(user),
    createdAt: user.createdAt,
  };
}

// Sign a 7-day JWT carrying the user id (middleware reads `id` back out).
function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error("JWT_SECRET is not configured on the server");
    err.status = 500;
    throw err;
  }
  return jwt.sign({ id: user._id }, secret, { expiresIn: TOKEN_TTL });
}

// POST /api/auth/signup
// Body: { name, email, username, password, dateOfBirth }
// Validates input, rejects duplicate email/username (400), hashes the password,
// creates the user, seeds the 3 default collections, returns { token, user }.
async function signup(req, res, next) {
  try {
    const { name, email, username, password, dateOfBirth } = req.body || {};

    // --- required fields ---
    const missing = [];
    if (!name || !String(name).trim()) missing.push("name");
    if (!email || !String(email).trim()) missing.push("email");
    if (!username || !String(username).trim()) missing.push("username");
    if (!password) missing.push("password");
    if (!dateOfBirth) missing.push("dateOfBirth");
    if (missing.length) {
      return res
        .status(400)
        .json({ ok: false, error: `Missing required field(s): ${missing.join(", ")}` });
    }

    // --- field-level checks ---
    const emailNorm = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ ok: false, error: "Invalid email address" });
    }
    if (String(password).length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: "Password must be at least 6 characters" });
    }
    const dob = new Date(dateOfBirth);
    if (Number.isNaN(dob.getTime())) {
      return res.status(400).json({ ok: false, error: "Invalid dateOfBirth" });
    }
    const usernameNorm = String(username).trim();

    // --- reject duplicates (email OR username), don't reveal which to attackers
    //     of the login route, but on signup it's helpful to say which is taken ---
    const existing = await User.findOne({
      $or: [{ email: emailNorm }, { username: usernameNorm }],
    }).lean();
    if (existing) {
      const field = existing.email === emailNorm ? "email" : "username";
      return res
        .status(400)
        .json({ ok: false, error: `An account with that ${field} already exists` });
    }

    // --- hash + create ---
    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const user = await User.create({
      name: String(name).trim(),
      email: emailNorm,
      username: usernameNorm,
      passwordHash,
      dateOfBirth: dob,
    });

    // --- seed default collections (best-effort: a seeding hiccup must not strand
    //     the user without an account they can already log into) ---
    try {
      await Collection.insertMany(
        DEFAULT_COLLECTIONS.map((cname) => ({
          userId: user._id,
          name: cname,
          isDefault: true,
        }))
      );
    } catch (seedErr) {
      console.error(
        "⚠️  Failed to seed default collections for",
        String(user._id),
        "-",
        seedErr.message
      );
    }

    const token = signToken(user);
    return res
      .status(201)
      .json({ ok: true, data: { token, user: publicUser(user) } });
  } catch (err) {
    // Defensive: a unique-index race can still produce a duplicate-key error.
    if (err && err.code === 11000) {
      const field = Object.keys(err.keyPattern || { account: 1 })[0];
      return res
        .status(400)
        .json({ ok: false, error: `An account with that ${field} already exists` });
    }
    return next(err);
  }
}

// POST /api/auth/login
// Body: { emailOrUsername, password }
// Looks up by email OR username, compares the hash, returns { token, user }.
// 401 on any failure — never reveal whether it was the identifier or the password.
async function login(req, res, next) {
  try {
    const { emailOrUsername, password } = req.body || {};
    if (!emailOrUsername || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "emailOrUsername and password are required" });
    }

    const id = String(emailOrUsername).trim();
    const user = await User.findOne({
      $or: [{ email: id.toLowerCase() }, { username: id }],
    });

    // Identical 401 for "no such user" and "wrong password".
    const passwordOk = user
      ? await bcrypt.compare(String(password), user.passwordHash)
      : false;
    if (!user || !passwordOk) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const token = signToken(user);
    return res.json({ ok: true, data: { token, user: publicUser(user) } });
  } catch (err) {
    return next(err);
  }
}

// GET /api/auth/me — protected by requireAuth, which has already set req.user.
function me(req, res) {
  return res.json({ ok: true, data: { user: publicUser(req.user) } });
}

module.exports = { signup, login, me, publicUser };
