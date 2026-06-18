// models/Collection.js — `collections` collection (see docs/DATA_MODEL.md).
// Items and the saved wheel are embedded (Mongo-idiomatic; no join tables).
const mongoose = require("mongoose");

// Embedded item: a reference into the shared `movies` cache by its numeric TMDB id.
const collectionItemSchema = new mongoose.Schema(
  {
    movieId: { type: Number, ref: "Movie", required: true }, // → Movie._id (TMDB id)
    addedAt: { type: Date, default: Date.now },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

// Embedded saved "Spin the Wheel" state. A slice is either a saved movie or a
// free-form text entry, so the shape is intentionally loose (DATA_MODEL leaves
// wheel items open).
const savedWheelItemSchema = new mongoose.Schema(
  {
    label: { type: String }, // displayed text (movie title or free-form entry)
    movieId: { type: Number, ref: "Movie" }, // set when the slice is a saved movie
  },
  { _id: false }
);

const collectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // owner
    name: { type: String, required: true },
    isPublic: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false }, // true for Favorites / Already Watched / Watchlist
    posterUrl: { type: String }, // optional custom cover
    items: { type: [collectionItemSchema], default: [] },
    savedWheel: { type: [savedWheelItemSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "collections" }
);

module.exports = mongoose.model("Collection", collectionSchema);
