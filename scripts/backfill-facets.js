// scripts/backfill-facets.js — one-off backfill of per-item filter facets.
//
// collectionItemSchema.genre_ids / provider_ids are only populated at add-time
// (collectionController.hydrateMovieOnAdd). Items added BEFORE that existed have
// empty facets, so the Spin-the-Wheel provider filter drops them all ("selecting
// any provider makes everything unavailable"). This script fetches each such
// item's genres + US flatrate providers from TMDB and writes them back.
//
//   cd server && node scripts/backfill-facets.js
//
// Safe + idempotent: only items with NO genre_ids are (re)hydrated — every movie
// has genres, so an empty genre_ids reliably means "never hydrated". A legitimately
// empty provider_ids (movie not on any US subscription service) is left untouched
// and won't be re-fetched on a second run. Results are cached per TMDB id, so a
// movie shared across many collections is fetched once.

require("dotenv").config();
const connectDB = require("../db_connection");
const mongoose = require("mongoose");
const Collection = require("../models/Collection");
const { tmdb } = require("../services/tmdb");

// One TMDB lookup → { genre_ids, provider_ids } (US flatrate). Mirrors the
// extraction in collectionController.hydrateMovieOnAdd so backfilled items match
// freshly-added ones exactly. Returns null on a dead/unknown id (item left as-is).
async function fetchFacets(tmdbId) {
  let movie;
  try {
    movie = await tmdb(`/movie/${tmdbId}`, { append_to_response: "watch/providers" });
  } catch (err) {
    console.warn(`  ⚠️  TMDB fetch failed for ${tmdbId} (${err.status || "?"}) — skipped`);
    return null;
  }

  const genre_ids = Array.isArray(movie.genres)
    ? movie.genres.map((g) => g && g.id).filter((id) => Number.isFinite(id))
    : [];

  const wp = movie["watch/providers"];
  const usFlatrate = wp && wp.results && wp.results.US && wp.results.US.flatrate;
  const provider_ids = Array.isArray(usFlatrate)
    ? usFlatrate.map((p) => p && p.provider_id).filter((id) => Number.isFinite(id))
    : [];

  return { genre_ids, provider_ids };
}

async function main() {
  await connectDB();

  const collections = await Collection.find({ "items.0": { $exists: true } });
  console.log(`Scanning ${collections.length} collection(s) with items…`);

  const cache = new Map(); // tmdbId → { genre_ids, provider_ids } (fetch once)
  let itemsChecked = 0;
  let itemsBackfilled = 0;
  let collectionsSaved = 0;

  for (const collection of collections) {
    let changed = false;

    for (const item of collection.items) {
      itemsChecked++;
      // Empty genre_ids == never hydrated (every real movie has genres).
      if (Array.isArray(item.genre_ids) && item.genre_ids.length > 0) continue;

      let facets = cache.get(item.movieId);
      if (facets === undefined) {
        facets = await fetchFacets(item.movieId);
        cache.set(item.movieId, facets);
      }
      if (!facets) continue; // dead id — leave the item untouched

      item.genre_ids = facets.genre_ids;
      item.provider_ids = facets.provider_ids;
      changed = true;
      itemsBackfilled++;
      console.log(
        `  ✓ ${collection.name} / movie ${item.movieId} → ` +
          `${facets.genre_ids.length} genre(s), ${facets.provider_ids.length} provider(s)`
      );
    }

    if (changed) {
      await collection.save();
      collectionsSaved++;
    }
  }

  console.log(
    `\nDone. Checked ${itemsChecked} item(s); backfilled ${itemsBackfilled}; ` +
      `saved ${collectionsSaved} collection(s); ${cache.size} unique movie(s) fetched.`
  );
  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exitCode = 1;
  mongoose.connection.close();
});
