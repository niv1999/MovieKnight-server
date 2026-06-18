// db_connection.js — MongoDB connection via Mongoose.
// Reads the connection string from process.env.MONGODB_URI and opens a single
// shared connection for the whole app.

const mongoose = require("mongoose");

// Connect to MongoDB. Resolves with the active connection, rejects if the
// MONGODB_URI is missing or the connection can't be established.
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set in the environment");
  }

  await mongoose.connect(uri);
  console.log("✅ MongoDB connected");
  return mongoose.connection;
}

module.exports = connectDB;
