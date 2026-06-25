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
const collectionRoutes = require("./routes/collectionRoutes");
const aiRoutes = require("./routes/aiRoutes");

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS: restrict to known frontends. The production site (apex + www) plus
//     local dev origins. We use Bearer tokens in the Authorization header (not
//     cookies), so credentials stay off and a strict origin allowlist is enough.
//     Override/extend in any environment via CORS_ORIGINS (comma-separated).
//     GET for the proxy reads; POST/PUT/PATCH/DELETE for auth + collections CRUD. ---
const DEFAULT_ALLOWED_ORIGINS = [
  "https://movieknight.site",
  "https://www.movieknight.site",
  // Local dev: VS Code Live Server, basic static server / UI test script (:8000),
  // and the API port itself. Both localhost + 127.0.0.1 since either may resolve.
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS)
);

app.use(
  cors({
    // `origin` is undefined for same-origin and non-browser clients (curl,
    // Postman, health checks) — allow those; otherwise enforce the allowlist.
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
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
  res.json({ ok: true, service: "movieknight-server" });
});

// --- API routes (controllers + routes, the taught layout) ---
// Every router is mounted under an explicit /api prefix here; the route files
// declare paths relative to that prefix (e.g. "/providers", not "/api/providers")
// so the prefix lives in exactly one place.
app.use("/api", movieRoutes); //   /api/movies/*
app.use("/api", peopleRoutes); //  /api/people/*
app.use("/api", catalogRoutes); // /api/genres, /api/providers
app.use("/api/auth", authRoutes); //  /api/auth/signup, /login, /me
app.use("/api/users", userRoutes); // /api/users/me (PATCH profile)
app.use("/api", collectionRoutes); // /api/collections/* (CRUD + add/remove movie)
app.use("/api/ai", aiRoutes); //   /api/ai/picker, /search, /enhance/:id (Gemini)

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
// Only errors we threw DELIBERATELY (those carry an explicit `err.status` — the
// validation 400s, 404s, mapped upstream/AI 5xx, etc.) expose their message to the
// client. An error with no `err.status` is an UNEXPECTED bug (a TypeError, a
// Mongoose error, …) whose raw `.message` could leak internals, so it becomes a
// 500 with a generic message — the full error is still logged server-side below.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = err.status ? err.message || "Server error" : "Server error";
  // Surface a machine-readable `code` only for deliberate errors (those with a
  // status) that set one — lets the client distinguish same-status cases, e.g. a
  // quota 429 (AI_LIMIT_REACHED) from an upstream rate-limit 429. Never leak a code
  // from an unexpected 500 (no status), which could expose internals.
  const code = err.status && err.code ? err.code : undefined;
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(status).json({ ok: false, error: message, ...(code && { code }) });
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
