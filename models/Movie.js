// models/Movie.js — `movies` collection: the TMDB cache.
// "Fetch once, store forever" — _id IS the numeric TMDB movie id, not an ObjectId.
const mongoose = require("mongoose");

const movieSchema = new mongoose.Schema(
  {
    _id: { type: Number, required: true }, // the numeric TMDB movie id — NOT an ObjectId
    title: { type: String },
    releaseYear: { type: Number },
    releaseDate: { type: Date },
    posterPath: { type: String },
    backdropPath: { type: String },
    overview: { type: String },
    rating: { type: Number }, // TMDB vote average
    tagline: { type: String }, // detail-only (not returned by list endpoints)
    runtime: { type: Number }, // detail-only, minutes
    director: { type: String },
    cast: { type: [String], default: [] },
    genres: { type: [String], default: [] },
    trailerKey: { type: String }, // YouTube key
    popularity: { type: Number },
    // false when the doc was first seen via a list endpoint (/discover, /search),
    // which don't return credits/videos. The details route fills the rest and
    // flips this to true; once true, the details page is served from Mongo.
    fullDetails: { type: Boolean, default: false },
    lastUpdated: { type: Date, default: Date.now },
  },
  { collection: "movies" }
);

module.exports = mongoose.model("Movie", movieSchema);
