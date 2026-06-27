const mongoose = require("mongoose");

const badgeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    tier: { type: String, enum: ["gold", "silver", "bronze"], required: true },
    subtitle: { type: String, default: "" },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true }, // never store plaintext
    name: { type: String },
    bio: { type: String, default: "" },
    dateOfBirth: { type: Date },
    avatarUrl: { type: String },
    countryCode: { type: String }, // ISO-3166 alpha-2
    badges: { type: [badgeSchema], default: [] },
    // `day` is the Pacific calendar day "YYYY-MM-DD" the count belongs to; an
    // earlier day reads as 0 (lazy midnight-Pacific reset, no cron/TTL).
    aiUsage: {
      count: { type: Number, default: 0 },
      day: { type: String, default: "" },
    },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "users" }
);

module.exports = mongoose.model("User", userSchema);
