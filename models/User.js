// models/User.js — `users` collection (see docs/DATA_MODEL.md).
const mongoose = require("mongoose");

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
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "users" }
);

module.exports = mongoose.model("User", userSchema);
