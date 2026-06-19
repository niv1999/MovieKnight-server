// models/User.js — `users` collection (see docs/DATA_MODEL.md).
const mongoose = require("mongoose");

// A progression badge (cosmetic, mock for now — dynamic earning is deferred).
// `tier` drives the shield's metal colour on the profile (gold/silver/bronze).
const badgeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "Movie Enthusiast"
    tier: { type: String, enum: ["gold", "silver", "bronze"], required: true },
    subtitle: { type: String, default: "" }, // tooltip line, e.g. "Silver Tier · 63 to Gold"
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true }, // bcryptjs hash — never store plaintext
    name: { type: String },
    bio: { type: String, default: "" }, // short profile bio; starts empty
    dateOfBirth: { type: Date },
    avatarUrl: { type: String }, // optional
    countryCode: { type: String }, // ISO-3166 alpha-2, optional
    // Earned progression badges. Empty for normal users (profile shows the empty
    // dashed shields); the Yuviverse7 demo user is seeded with three.
    badges: { type: [badgeSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "users" }
);

module.exports = mongoose.model("User", userSchema);
