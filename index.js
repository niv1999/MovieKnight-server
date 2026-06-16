// index.js — MovieKnight API entry point.
// Express app: middleware -> routes -> 404/error handlers -> start.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const connectDB = require("./db_connection");

const authRoutes = require("./routes/authRoutes");
const movieRoutes = require("./routes/movieRoutes");
const collectionRoutes = require("./routes/collectionRoutes");

const app = express();

// --- middleware ---
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(morgan("dev"));

// --- health check ---
app.get("/", (req, res) => {
  res.json({ ok: true, data: "MovieKnight API is running 🎬" });
});

// --- routes ---
app.use("/api/auth", authRoutes);
app.use("/api/movies", movieRoutes);
app.use("/api/collections", collectionRoutes);

// --- 404 (no route matched) ---
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Route not found" });
});

// --- central error handler ---
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Server error" });
});

// --- start ---
const PORT = process.env.PORT || 5000;
connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
});
