// scripts/seed-demo.js — seed the "Yuviverse7" classroom demo user.
//
// Creates (idempotently) a user with the three progression badges (cosmetic mock,
// read by the profile UI by tier), the Figma bio, a custom avatar, and rich
// collection data (varied sizes) so the profile + collection pages have plenty to
// demonstrate.
//
//   cd server && node scripts/seed-demo.js
//
// Safe to re-run: it wipes and recreates only Yuviverse7's own user + collections.

require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("../db_connection");
const User = require("../models/User");
const Collection = require("../models/Collection");
const Movie = require("../models/Movie");
const { tmdb } = require("../services/tmdb");

const USERNAME = "Yuviverse7";
const EMAIL = "yuviverse7@movieknight.site";
const PASSWORD = "Yuviverse7"; // upper+lower+digit, 10 chars
const AVATAR = "assets/images/yuviverse-profile-pic.png";

const BIO =
  "The 7 stands for how many times I watched Rocky this week 🥊\n" +
  "Barbie is overrated #team_oppenheimer\n" +
  "Real men cry 😭";

const BADGES = [
  { name: "Movie Enthusiast", tier: "silver", subtitle: "Silver Tier · 63 movies until Gold" },
  { name: "Old-School Enjoyer", tier: "gold", subtitle: "Gold Tier · 262 / 200 movies" },
  { name: "Collection Master", tier: "bronze", subtitle: "Bronze Tier · 21 collections until Silver" },
];

// Collections: name, public/default, the thematic "lead" movies (shown in the
// 2×2 cover), and the TOTAL size to pad to (from a popular-movie pool). Two lists
// stay small (2–3); the rest are large (8 / 12 / 20 / 23 / 53).
const COLLECTIONS = [
  { name: "Favorites", isDefault: true, isPublic: false, leads: [1366, 238, 278], count: 3 },
  { name: "Watchlist", isDefault: true, isPublic: false, leads: [27205, 157336], count: 2 },
  { name: "Already Watched", isDefault: true, isPublic: false, leads: [680, 550, 769, 13], count: 8 },
  { name: "Must Watch Classics", isDefault: false, isPublic: true, leads: [238, 680, 278, 289], count: 12 },
  { name: "Horror Night", isDefault: false, isPublic: true, leads: [694, 948, 539, 9552], count: 20 },
  { name: "90s Gems", isDefault: false, isPublic: false, leads: [603, 550, 329], count: 23 },
  { name: "The Rocky Saga", isDefault: false, isPublic: false, leads: [1366, 1367, 1245, 1374], count: 53 },
];

// Upsert a movie record from a TMDB object (list result OR /movie/:id response).
async function cache(m) {
  if (!m || m.id == null) return false;
  await Movie.updateOne(
    { _id: m.id },
    {
      $set: {
        title: m.title || m.original_title || "",
        releaseYear: m.release_date ? Number(String(m.release_date).slice(0, 4)) || null : null,
        releaseDate: m.release_date ? new Date(m.release_date) : null,
        posterPath: m.poster_path || null,
        backdropPath: m.backdrop_path || null,
        overview: m.overview || "",
        rating: m.vote_average ?? null,
        popularity: m.popularity ?? null,
        lastUpdated: new Date(),
      },
      $setOnInsert: { fullDetails: false },
    },
    { upsert: true }
  );
  return true;
}

async function cacheId(id, cached) {
  if (cached.has(id)) return true;
  try {
    const m = await tmdb(`/movie/${id}`);
    await cache(m);
    cached.add(id);
    return true;
  } catch (err) {
    console.warn(`  ! could not cache movie ${id}: ${err.message}`);
    return false;
  }
}

async function main() {
  await connectDB();
  const cached = new Set();

  // 1. A pool of popular movies to pad the large collections (enough for the 53).
  const pool = [];
  for (let p = 1; p <= 4; p++) {
    try {
      const data = await tmdb("/movie/popular", { page: p });
      for (const m of data.results || []) {
        if (await cache(m)) {
          cached.add(m.id);
          pool.push(m.id);
        }
      }
    } catch (err) {
      console.warn(`  ! popular page ${p}: ${err.message}`);
    }
  }
  console.log(`✔ cached movie pool: ${pool.length}`);

  // 2. The demo user.
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.findOneAndUpdate(
    { username: USERNAME },
    {
      $set: {
        username: USERNAME,
        email: EMAIL,
        passwordHash,
        name: "Yuviverse",
        bio: BIO,
        avatarUrl: AVATAR,
        badges: BADGES,
        dateOfBirth: new Date("1985-12-03"),
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
  console.log(`✔ user ${USERNAME} (${user._id})`);

  // 3. Rebuild collections, padding each to its target size with unique movies.
  await Collection.deleteMany({ userId: user._id });
  for (const col of COLLECTIONS) {
    const ids = [];
    const seen = new Set();
    const take = (id) => {
      if (id == null || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const id of col.leads) {
      if (await cacheId(id, cached)) take(id);
    }
    for (const id of pool) {
      if (ids.length >= col.count) break;
      take(id);
    }
    const items = ids.slice(0, col.count).map((id) => ({ movieId: id, addedAt: new Date() }));
    await Collection.create({
      userId: user._id,
      name: col.name,
      isPublic: col.isPublic,
      isDefault: col.isDefault,
      items,
    });
    console.log(`  • ${col.name} (${items.length} movies, ${col.isPublic ? "public" : "private"})`);
  }

  console.log("\n=== DEMO USER READY ===");
  console.log(`  username: ${USERNAME}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  avatar:   ${AVATAR}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
