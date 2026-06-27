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

const DEFAULT_ALLOWED_ORIGINS = [
  "https://movieknight.site",
  "https://www.movieknight.site",
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
    // origin is undefined for same-origin / non-browser clients (curl, health checks)
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Accept", "Content-Type", "Authorization"],
  })
);

// 2mb headroom for a base64 avatar data URL on PATCH /api/users/me
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({ ok: true, service: "movieknight-server" });
});

app.use("/api", movieRoutes);
app.use("/api", peopleRoutes);
app.use("/api", catalogRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api", collectionRoutes);
app.use("/api/ai", aiRoutes);

// envelope shape under /api, named-payload elsewhere. originalUrl isn't rewritten by sub-routers.
app.use((req, res) => {
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }
  res.status(404).json({ error: "Not found" });
});

// only errors with explicit err.status expose their message; anything else is a
// generic 500 so raw .message can't leak internals. 4-arg signature required by Express.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = err.status ? err.message || "Server error" : "Server error";
  // only surface code for deliberate errors, never from an unexpected 500
  const code = err.status && err.code ? err.code : undefined;
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(status).json({ ok: false, error: message, ...(code && { code }) });
  }
  res.status(status).json({ error: message });
});

// non-fatal: the proxy still serves if the database is unreachable
connectDB().catch((err) => {
  console.error("⚠️  MongoDB connection failed:", err.message);
});

app.listen(PORT, () => {
  console.log(`🎬 TMDB proxy listening on http://localhost:${PORT}`);
});
