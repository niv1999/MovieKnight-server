// models/Movie.js — `movies` collection: the TMDB cache (see docs/DATA_MODEL.md).
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
    director: { type: String },
    cast: { type: [String], default: [] },
    genres: { type: [String], default: [] },
    trailerKey: { type: String }, // YouTube key
    popularity: { type: Number },
    lastUpdated: { type: Date, default: Date.now },
  },
  { collection: "movies" }
);

module.exports = mongoose.model("Movie", movieSchema);
