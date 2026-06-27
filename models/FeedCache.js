// feed/search cache: one doc per query+page, holding only the ordered movieIds
// (content lives in `movies`). TTL-bounded since ordering drifts as popularity does.
const mongoose = require("mongoose");

const FEED_TTL_SECONDS = 60 * 60 * 12; // 12h

const feedCacheSchema = new mongoose.Schema(
  {
    _id: { type: String }, // query fingerprint (services/movieCache.feedKey)
    movieIds: { type: [Number], default: [] }, // ordered, sort reapplied from this
    fetchedAt: { type: Date, default: Date.now },
  },
  { collection: "feedcache" }
);

feedCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: FEED_TTL_SECONDS });

module.exports = mongoose.model("FeedCache", feedCacheSchema);
module.exports.FEED_TTL_SECONDS = FEED_TTL_SECONDS;
