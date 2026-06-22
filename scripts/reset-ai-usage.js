// scripts/reset-ai-usage.js — one-off: materialise the daily AI-quota field on
// every existing user with a clean slate (count 0, no day stamp).
//
//   cd server && node scripts/reset-ai-usage.js
//
// Context: the daily AI limit (services/aiQuota.js) resets LAZILY — a user with no
// `aiUsage` field already reads as 0 used today, so this script isn't required for
// correctness. It just writes the field onto current documents so everyone starts
// fresh and the shape is explicit in the DB. Safe + idempotent: re-running it only
// re-zeroes the counters (an empty `day` means "no count belongs to today").

require("dotenv").config();
const connectDB = require("../db_connection");
const mongoose = require("mongoose");
const User = require("../models/User");

async function main() {
  await connectDB();

  const result = await User.updateMany(
    {},
    { $set: { aiUsage: { count: 0, day: "" } } }
  );

  // Mongoose returns matchedCount/modifiedCount on the write result.
  console.log(
    `Done. Matched ${result.matchedCount} user(s); reset aiUsage on ${result.modifiedCount}.`
  );
  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exitCode = 1;
  mongoose.connection.close();
});
