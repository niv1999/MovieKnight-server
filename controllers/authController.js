const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Collection = require("../models/Collection");
const { aiUsageFor } = require("../services/aiQuota");

const BCRYPT_ROUNDS = 10;
const TOKEN_TTL = "7d";

const DEFAULT_COLLECTIONS = ["Favorites", "Already Watched", "Watchlist"];

// allow-list so passwordHash can never leak
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
    aiUsage: aiUsageFor(user),
    createdAt: user.createdAt,
  };
}

function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error("JWT_SECRET is not configured on the server");
    err.status = 500;
    throw err;
  }
  return jwt.sign({ id: user._id }, secret, { expiresIn: TOKEN_TTL });
}

async function signup(req, res, next) {
  try {
    const { name, email, username, password, dateOfBirth } = req.body || {};

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

    const existing = await User.findOne({
      $or: [{ email: emailNorm }, { username: usernameNorm }],
    }).lean();
    if (existing) {
      const field = existing.email === emailNorm ? "email" : "username";
      return res
        .status(400)
        .json({ ok: false, error: `An account with that ${field} already exists` });
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const user = await User.create({
      name: String(name).trim(),
      email: emailNorm,
      username: usernameNorm,
      passwordHash,
      dateOfBirth: dob,
    });

    // best-effort: seeding failure must not block the already-created account
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
    // unique-index race
    if (err && err.code === 11000) {
      const field = Object.keys(err.keyPattern || { account: 1 })[0];
      return res
        .status(400)
        .json({ ok: false, error: `An account with that ${field} already exists` });
    }
    return next(err);
  }
}

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

    // same 401 whether user missing or password wrong
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

function me(req, res) {
  return res.json({ ok: true, data: { user: publicUser(req.user) } });
}

module.exports = { signup, login, me, publicUser };
