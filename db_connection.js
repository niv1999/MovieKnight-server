// db_connection.js — connects to MongoDB Atlas via Mongoose.
// NOTE: real models/queries are wired after Thursday's Mongo lecture (task S3).
// Until MONGODB_URI is set, the server still boots on stub data (task S1).

const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri || uri.startsWith("your_")) {
    console.log("⚠️  No MONGODB_URI yet — running on stub data (pre-Mongo lecture).");
    return;
  }

  try {
    await mongoose.connect(uri);
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
