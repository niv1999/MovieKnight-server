// index.js — MovieKnight API server (Node/Express).
// Thin entry point: middleware + route mounting + DB connection. Every TMDB call
// lives behind a controller (services/tmdb.js holds the key), so the frontend
// never sees the API key. Routes are split into routes/ + controllers/ (the
// taught layout); see docs/API_CONTRACT.md for the full contract.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./db_connection");

const movieRoutes = require("./routes/movieRoutes");
const peopleRoutes = require("./routes/peopleRoutes");
const catalogRoutes = require("./routes/catalogRoutes");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS: allow any origin. GET for the proxy reads; POST/PUT/PATCH/DELETE for
//     the auth + (upcoming) collections CRUD routes. Authorization carries the
//     Bearer token; Content-Type is needed for JSON request bodies. ---
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Accept", "Content-Type", "Authorization"],
  })
);

// Parse JSON request bodies (auth/collections POST + PUT). The 2mb limit leaves
// room for a small base64 avatar data URL on PATCH /api/users/me (client resizes
// to ~256px first, so real payloads are tiny — this is just headroom).
app.use(express.json({ limit: "2mb" }));

// --- health check ---
app.get("/", (req, res) => {
  res.json({ ok: true, service: "movieknight-tmdb-proxy" });
});

// --- API routes (controllers + routes, the taught layout) ---
// Mounted at the root; each router declares its own full paths.
app.use(movieRoutes); //   /movies (legacy) + /api/movies/*
app.use(peopleRoutes); //  /api/people/*
app.use(catalogRoutes); // /api/genres, /api/providers
app.use("/api/auth", authRoutes); //  /api/auth/signup, /login, /me
app.use("/api/users", userRoutes); // /api/users/me (PATCH profile)

// --- 404: contract envelope under /api, named-payload shape elsewhere ---
// Use req.originalUrl (never rewritten by sub-routers) so the shape stays correct
// for routes served via app.use("/api/...", router), not just inline app.get.
app.use((req, res) => {
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }
  res.status(404).json({ error: "Not found" });
});

// --- central error handler: surface TMDB/config status codes ---
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = err.message || "Server error";
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(status).json({ ok: false, error: message });
  }
  res.status(status).json({ error: message });
});

// Open the MongoDB connection on startup. Non-fatal: the TMDB proxy still serves
// even if the database is unreachable.
connectDB().catch((err) => {
  console.error("⚠️  MongoDB connection failed:", err.message);
});

app.listen(PORT, () => {
  console.log(`🎬 TMDB proxy listening on http://localhost:${PORT}`);
});
