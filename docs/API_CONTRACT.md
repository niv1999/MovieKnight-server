# API Contract — MovieKnight (v0)

- **Base path:** `/api` · **Base URL:** `<API_BASE_URL>` (Render backend; `http://localhost:5000` in dev)
- **Response convention:** success `{ ok: true, data }` · error `{ ok: false, error }` · proper HTTP status codes
- **Auth:** protected routes require `Authorization: Bearer <token>`

> Source of truth for both lanes. **Any change → post in `#api-contract` with @mention BEFORE merging.**
> The current server returns **stub data** (task S1); real behavior lands in S4–S6.

## Auth
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| POST | `/api/auth/signup` | `{name,email,username,password,dateOfBirth}` | `{token, user}` | — |
| POST | `/api/auth/login` | `{emailOrUsername,password}` | `{token, user}` | — |
| GET | `/api/auth/me` | — | `{user}` | Bearer |

Signup also seeds the 3 default collections (Favorites, Already Watched, Watchlist).

## Movies (TMDB-backed, cached)
| Method | Path | Query / Params | Returns |
|---|---|---|---|
| GET | `/api/movies/search` | `q, genre, year, minRating, sort` | `[movie]` |
| GET | `/api/movies/:tmdbId` | `tmdbId` | `{movie detail}` |

`search` = **complex query #1** (combined filters + sort).

## Collections (Bearer)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/collections` | — | `[collection]` (mine) |
| POST | `/api/collections` | `{name}` | `{collection}` |
| GET | `/api/collections/:id` | — | `{collection + movies}` ← **complex query #2** (join items↔movies) |
| PATCH | `/api/collections/:id` | `{name?, isPublic?, order?}` | `{collection}` |
| DELETE | `/api/collections/:id` | — | `{deleted}` |
| POST | `/api/collections/:id/movies` | `{tmdbId}` | `{collection}` |
| DELETE | `/api/collections/:id/movies/:tmdbId` | — | `{collection}` |

## Wheel (Spin the Wheel persistence)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/collections/:id/wheel` | — | `{wheelConfig}` |
| PUT | `/api/collections/:id/wheel` | `{wheelConfig}` | `{saved}` |

## Error shape
`{ ok: false, error: "message" }` with status **400** (bad input) · **401** (no/invalid token) · **404** (not found) · **500** (server).
