const mongoose = require("mongoose");

const collectionItemSchema = new mongoose.Schema(
  {
    movieId: { type: Number, ref: "Movie", required: true }, // → Movie._id (TMDB id)
    addedAt: { type: Date, default: Date.now },
    sortOrder: { type: Number, default: 0 },
    // facets embedded so the grid filters by genre/service without a per-movie
    // lookup. provider_ids → US flatrate watch-provider ids.
    genre_ids: { type: [Number], default: [] },
    provider_ids: { type: [Number], default: [] },
  },
  { _id: false }
);

// must match client SORTS keys in client/js/pages/collection/shared.js
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
    // indexed: every "list a user's collections" query filters on userId
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    isPublic: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false }, // Favorites / Already Watched / Watchlist
    posterUrl: { type: String },
    sort: { type: String, enum: SORT_KEYS, default: "added_desc" },
    items: { type: [collectionItemSchema], default: [] },
    savedWheel: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "collections" }
);

const Collection = mongoose.model("Collection", collectionSchema);
Collection.SORT_KEYS = SORT_KEYS;
module.exports = Collection;
