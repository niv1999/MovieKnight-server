// models/FeedCache.js — the feed/search cache (see docs/DATA_MODEL.md).
// One document per distinct query+page: `_id` is a canonical fingerprint of the
// request (filters + sort + page), `movieIds` is the ORDERED list of TMDB ids
// that query returned. The movie content itself lives in `movies` (kept ~forever);
// this collection only caches the *ordering*, which goes stale as popularity drifts.
//
// "Not forever" is enforced by a MongoDB TTL index on `fetchedAt`: mongod's TTL
// monitor (runs ~every 60s) deletes entries once they pass FEED_TTL_SECONDS. No
// cron, no manual cleanup — an absent doc simply reads as a cache miss.
const mongoose = require("mongoose");

const FEED_TTL_SECONDS = 60 * 60 * 12; // 12h — long enough to dodge re-fetches on
//                                        navigation, short enough that ordering
//                                        and ratings never look stale to a user.

const feedCacheSchema = new mongoose.Schema(
  {
    _id: { type: String }, // canonical query fingerprint (see services/movieCache.feedKey)
    movieIds: { type: [Number], default: [] }, // ORDERED — sort is reapplied from this
    fetchedAt: { type: Date, default: Date.now },
  },
  { collection: "feedcache" }
);

// TTL index: Mongo auto-deletes a doc ~FEED_TTL_SECONDS after its fetchedAt.
feedCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: FEED_TTL_SECONDS });

module.exports = mongoose.model("FeedCache", feedCacheSchema);
module.exports.FEED_TTL_SECONDS = FEED_TTL_SECONDS;
