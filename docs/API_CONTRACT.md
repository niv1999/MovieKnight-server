# API Contract — MovieKnight (v0)

- **Base path:** `/api` · **Base URL:** `<API_BASE_URL>` (Render backend; `http://localhost:5000` in dev)
- **Response convention:** success `{ ok: true, data }` · error `{ ok: false, error }` · proper HTTP status codes
- **Auth:** protected routes require `Authorization: Bearer <token>`

> Source of truth for both lanes. **Any change → post in `#api-contract` with @mention BEFORE merging.**
> The **TMDB proxy layer is now live** (see _TMDB Proxy — IMPLEMENTED_ below). The Auth / Collections / Wheel
> tables below are still the **target** contract — not yet implemented on the server (lands in S4–S6).

## Auth
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| POST | `/api/auth/signup` | `{name,email,username,password,dateOfBirth}` | `{token, user}` | — |
| POST | `/api/auth/login` | `{emailOrUsername,password}` | `{token, user}` | — |
| GET | `/api/auth/me` | — | `{user}` | Bearer |

Signup also seeds the 3 default collections (Favorites, Already Watched, Watchlist).

## Movies (TMDB-backed, cached)
| Method | Path | Query / Params | Returns | Status |
|---|---|---|---|---|
| GET | `/api/movies/search` | `q, genre, yearFrom, yearTo, minRating, minVotes, language, with_cast, with_crew, sort, page` | `{ ok:true, data:[movie] }` | ✅ implemented |
| GET | `/api/movies/random` | — | `{ ok:true, data:{movie} }` | ✅ implemented |
| GET | `/api/people/search` | `q` | `{ ok:true, data:[{id,name,profile_path,known_for_department}] }` | ✅ implemented |
| GET | `/api/people/popular` | `page` | `{ ok:true, data:[{id,name,profile_path,known_for_department}] }` — pre-fills actor/director dropdowns; filtered to mostly-English `known_for` (US/Hollywood bias) | ✅ implemented |
| GET | `/api/genres` | — | `{ ok:true, data:[{id,name}] }` | ✅ implemented |
| GET | `/api/providers` | — | `{ ok:true, data:[{provider_id,provider_name,logo_path,display_priority}] }` | ✅ implemented |
| GET | `/api/movies/:tmdbId` | `tmdbId` | `{ ok:true, data:{movie detail} }` | ⛔ not yet |

`search` = **complex query #1** (combined filters + sort).

### `GET /api/movies/search`
- **Params:** `q` (title text; **empty/omitted → popular movies feed**) · `genre` (TMDB genre id) · `yearFrom` / `yearTo` (4-digit, inclusive release-year range; either bound is optional) · `minRating` (0–10 floor) · `minVotes` (optional; minimum TMDB vote count → `vote_count.gte`; quality floor that keeps obscure, barely-rated titles out of the feed) · `language` (optional; ISO 639-1 code, e.g. `en` → `with_original_language`; restricts to a single original language) · `with_cast` (actor person id) · `with_crew` (director person id) · `sort` · `page` (default 1).
- **Filters (all TMDB-native on the discover path):** `genre` → `with_genres`, `yearFrom`/`yearTo` → `primary_release_date.gte`/`.lte`, `minRating` → `vote_average.gte`, `minVotes` → `vote_count.gte`, `language` → `with_original_language`. On the free-text path (`q` with no person filter, which uses `/search/movie` and can't honor them), the server re-applies all of these on the page so behavior is identical either way. With a rating sort and no explicit `minVotes`, a default `vote_count.gte` floor of 50 is applied so single-vote titles don't dominate.
- **Person filters:** `with_cast` / `with_crew` route the query through TMDB `/discover` (which is the only endpoint that supports them). Because `/discover` can't honor free text, when `q` is also supplied the title match is applied server-side on top of the person-filtered results.
- **`sort`** — allowable values: `popularity` *(default)*, `rating_desc`, `rating_asc`, `title_asc`, `title_desc`, `year_desc`, `year_asc`. Unknown/missing → `popularity`. On the discover path the sort is native via TMDB `sort_by` (title → `original_title.*`, year → `primary_release_date.*`). The `/search/movie` text path can't `sort_by`, so there the requested sort only orders within the returned page. Undated titles sort to the bottom on `year_*` and are excluded when a `yearFrom`/`yearTo` range is set.
- **Pagination:** 20 movies per page via `page`, forwarded **1:1** to the underlying TMDB page (TMDB serves up to page 500). Result sets don't shrink as you scroll; the response is empty only when TMDB itself has no more pages. Nothing is sliced or capped to a fixed pool of source pages.
- **Response:** `{ ok:true, data:[movie] }` — `data` is the ordered, paged array (raw TMDB movie objects for now; field-reshaping to the `DATA_MODEL` shape is a separate, still-open task).

### `GET /api/movies/random`
- Returns one random non-adult movie via brute-force ID lookup. `{ ok:true, data:{movie} }`.

## TMDB Proxy — IMPLEMENTED (current server)

> These are the routes the server **actually serves today**. They are a thin, read-only
> proxy to TMDB so the API key never reaches the client. **No `/api` prefix and no
> `{ok,data}` envelope** — each route returns a named payload (`{movies}`, `{movie}`,
> `{people}`, `{genres}`, `{providers}`); errors are `{ error: "message" }` with the
> upstream/typical HTTP status. Aligning these with the `/api` + `{ok,data}` convention
> is still an open decision — flag in `#api-contract` before changing.

| Method | Path | Query / Params | Returns |
|---|---|---|---|
| GET | `/movies` | `page` (1–500), `with_genres`, `with_cast`, `with_crew`, `with_watch_providers`, `watch_region`, `primary_release_date.gte`/`.lte`, `vote_average.gte`, `vote_count.gte`, `sort_by` | `{ movies: [...] }` — popular feed when no filters; `/discover` when any filter present |
| GET | `/movies/random` | — | `{ movie }` — truly-random deep-catalog title via brute-force ID lookup; `{ movie, fallback: true }` if the 20-attempt loop maxes out and falls back to a popular title |
| GET | `/movies/search` | `query` | `{ movies: [...] }` — TMDB title search; empty `query` → `{ movies: [] }` |

> **Moved to `/api` (contract `{ ok:true, data:[...] }` envelope, prefix-less paths removed):**
> `/genres` → `GET /api/genres` · `/providers` → `GET /api/providers` · `/people/search` → `GET /api/people/search`.

**Filtering by person:** resolve a name via `GET /api/people/search`, then pass the chosen `id` to
`/api/movies/search?with_cast=<id>` (actor) or `/api/movies/search?with_crew=<id>` (director).

> ⚠️ **Duplication note:** `/movies/search` and `/movies/random` (prefix-less, named-payload)
> now have contract-shaped twins `/api/movies/search` and `/api/movies/random` (see _Movies_
> above). Both sets are live during migration. Once the frontend moves to the `/api` versions,
> the prefix-less `/movies/search` and `/movies/random` should be removed.

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
