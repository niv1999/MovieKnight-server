// middleware/auth.js — gate for protected routes.
// Reads `Authorization: Bearer <token>`, verifies the JWT with JWT_SECRET, loads
// the user (minus passwordHash) and attaches it as req.user. Any problem → 401.

const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res
        .status(401)
        .json({ ok: false, error: "Missing or malformed Authorization header" });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      const err = new Error("JWT_SECRET is not configured on the server");
      err.status = 500;
      throw err; // a server misconfig is a 500, not a client 401
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (_) {
      // expired, tampered, or signed with a different secret
      return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    }

    // Load the live user so a deleted account can't keep using an old token.
    const user = await User.findById(payload.id).select("-passwordHash");
    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    }

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = requireAuth;
