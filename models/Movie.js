// TMDB cache, "fetch once, store forever". _id IS the numeric TMDB movie id.
const mongoose = require("mongoose");

const movieSchema = new mongoose.Schema(
  {
    _id: { type: Number, required: true },
    title: { type: String },
    releaseYear: { type: Number },
    releaseDate: { type: Date },
    posterPath: { type: String },
    backdropPath: { type: String },
    overview: { type: String },
    rating: { type: Number },
    tagline: { type: String },
    runtime: { type: Number },
    director: { type: String },
    cast: { type: [String], default: [] },
    genres: { type: [String], default: [] },
    trailerKey: { type: String },
    popularity: { type: Number },
    // false until the details route fills credits/videos (list endpoints omit
    // them); once true, the details page is served from Mongo.
    fullDetails: { type: Boolean, default: false },
    lastUpdated: { type: Date, default: Date.now },
  },
  { collection: "movies" }
);

module.exports = mongoose.model("Movie", movieSchema);
