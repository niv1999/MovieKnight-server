// models/Collection.js — `collections` collection.
// Items and the saved wheel are embedded (Mongo-idiomatic; no join tables).
const mongoose = require("mongoose");

// Embedded item: a reference into the shared `movies` cache by its numeric TMDB id.
const collectionItemSchema = new mongoose.Schema(
  {
    movieId: { type: Number, ref: "Movie", required: true }, // → Movie._id (TMDB id)
    addedAt: { type: Date, default: Date.now },
    sortOrder: { type: Number, default: 0 },
    // Filter facets, hydrated from TMDB at add-time (collectionController.addMovie).
    // Embedded on the item — not just the shared `movies` cache — so the frontend
    // can filter a collection's grid by genre/streaming service without an extra
    // per-movie lookup. genre_ids → TMDB genre ids; provider_ids → US flatrate
    // (streaming) watch-provider ids.
    genre_ids: { type: [Number], default: [] },
    provider_ids: { type: [Number], default: [] },
  },
  { _id: false }
);

// Embedded saved "Spin the Wheel" state. The client persists the wheel as a
// plain array of strings (movie titles / free-form entries), so the model stores
// [String] to match that format byte-for-byte (DATA_MODEL leaves wheel items open).

// The collection-page "Sort by" choices (must match client SORTS keys in
// client/js/pages/collection/shared.js). Stored per-collection so a user's chosen
// ordering is remembered the next time they open that list.
const SORT_KEYS = [
  "added_desc",
  "added_asc",
  "title_asc",
  "title_desc",
  "year_desc",
  "year_asc",
];

const collectionSchema = new mongoose.Schema(
  {
    // Owner. Indexed: every "list a user's collections" query filters on this
    // (Collection.find({ userId })), so the index turns a collection scan into a
    // direct lookup — this is what makes the one-to-many efficient, not a
    // collections[] array on the user (see note below).
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    isPublic: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false }, // true for Favorites / Already Watched / Watchlist
    posterUrl: { type: String }, // optional custom cover
    sort: { type: String, enum: SORT_KEYS, default: "added_desc" }, // remembered "Sort by"
    items: { type: [collectionItemSchema], default: [] },
    savedWheel: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "collections" }
);

const Collection = mongoose.model("Collection", collectionSchema);
Collection.SORT_KEYS = SORT_KEYS; // shared with the controller's PATCH validation
module.exports = Collection;
