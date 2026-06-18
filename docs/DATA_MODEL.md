# Data Model — MongoDB (Mongoose)

Document model (not the SRS relational tables). **3 core collections** for the MVP.
Collection items + the saved wheel are **embedded** inside the collection document (Mongo-idiomatic; no join tables).

## `users`
| Field | Type | Notes |
|---|---|---|
| _id | ObjectId | |
| username | String | unique, required |
| email | String | unique, required |
| passwordHash | String | bcryptjs hash — never store plaintext |
| name | String | from signup |
| bio | String | short profile bio; defaults to `""` (shown/edited on the profile page) |
| dateOfBirth | Date | from signup |
| avatarUrl | String | optional |
| countryCode | String | ISO-3166 alpha-2, optional |
| createdAt | Date | default now |

## `movies` (TMDB cache — "fetch once, store forever")
| Field | Type | Notes |
|---|---|---|
| _id | Number | the TMDB movie id |
| title | String | |
| releaseYear | Number | |
| releaseDate | Date | |
| posterPath | String | |
| backdropPath | String | |
| overview | String | |
| rating | Number | TMDB vote average |
| tagline | String | detail-only (not returned by list endpoints) |
| runtime | Number | detail-only, minutes |
| director | String | |
| cast | [String] | |
| genres | [String] | names; only filled by the details fetch |
| trailerKey | String | YouTube key |
| popularity | Number | |
| fullDetails | Boolean | `false` when first seen via a list endpoint (`/discover`, `/search`), which omit credits/videos; the details route fills the rest and flips it `true`. Once `true`, the details page is served from Mongo. Default `false`. |
| lastUpdated | Date | refreshed on every write (lazy freshness for the volatile numbers) |

## `feedcache` (search/feed cache — TTL'd ordering)
The movie *content* lives in `movies` (kept ~forever); this collection caches only the *ordering* of a query, which goes stale as popularity/rating drift. One document per distinct query+page.
| Field | Type | Notes |
|---|---|---|
| _id | String | canonical fingerprint of the request (filters + sort + page) — see `services/movieCache.feedKey` |
| movieIds | [Number] | **ordered** TMDB ids the query returned (→ `movies._id`); the sort is re-imposed from this on read |
| fetchedAt | Date | write time; a **TTL index** (`expireAfterSeconds: 12h`) lets Mongo auto-delete the entry — an absent doc reads as a cache miss |

**Flow:** `GET /api/movies/search` checks `feedcache` first; on a hit it loads the `movieIds` from `movies` (re-ordered) — no TMDB call. On a miss it fetches TMDB, upserts each movie into `movies` (refreshing the volatile numbers), and records the ordered id list here. The whole layer is best-effort: with no/unreachable Mongo it transparently falls back to a direct TMDB fetch (see `services/movieCache.js`).

## `collections`
| Field | Type | Notes |
|---|---|---|
| _id | ObjectId | |
| userId | ObjectId → users | owner |
| name | String | required |
| isPublic | Boolean | default false |
| isDefault | Boolean | true for Favorites / Already Watched / Watchlist |
| posterUrl | String | optional custom cover |
| items | `[{ movieId: Number→movies._id, addedAt: Date, sortOrder: Number }]` | embedded |
| savedWheel | `[ ...wheel items ]` | embedded; Spin the Wheel persistence |
| createdAt | Date | default now |

## Relationships
- `users` 1—* `collections` (via `userId`).
- `collections` *—* `movies` via embedded `items[]` (`movieId` references the `movies` cache).
- Deleting a user → delete their collections. The `movies` cache is shared and never deleted with a collection.

### Referencing direction — why the ref lives on `collections`, not a `user.collections[]` array
The link is stored **once**, on the "many" side (`collections.userId`), and `collections.userId` is **indexed**. Listing a user's collections is therefore `Collection.find({ userId })` — a direct index lookup that scales to any number of collections.

We deliberately do **not** keep a `collections: [ObjectId]` array on the `users` doc:
- It would duplicate the relationship in two places → two writes per create/delete (insert + `$push`, delete + `$pull`) and a real risk of drift (orphaned ids / missing ids) since we have no multi-doc transactions.
- It buys nothing on reads at this scale — the `userId` index already makes the lookup O(log n + k).
- Single source of truth = the list can never go stale.

If a screen needs the user **and** their collections in one shot (e.g. profile), **join at read time** (query `collections` by `userId` and return them alongside the user) rather than storing the list on the user. For an ordered display, add a `sortOrder: Number` to `collections` (and later a compound index `{ userId: 1, sortOrder: 1 }`) instead of relying on array position.

## The 2 required complex queries
1. **Movie search** — filter `movies` by genre/year/minRating + sort (`GET /api/movies/search`).
2. **Collection with movies** — aggregation / `populate` joining a collection's `items[]` with the `movies` cache to return full movie objects (`GET /api/collections/:id`).

## Deferred (not in MVP — see SPRINT_PLAN §11)
likes / saves (Explore) · userPreferences (Preferences page).
