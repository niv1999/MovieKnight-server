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
| director | String | |
| cast | [String] | |
| genres | [String] | |
| trailerKey | String | YouTube key |
| popularity | Number | |
| lastUpdated | Date | |

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
