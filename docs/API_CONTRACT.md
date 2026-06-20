# API Contract — MovieKnight (v0)

- **Base path:** `/api` · **Base URL:** `<API_BASE_URL>` (Render backend; `http://localhost:3000` in dev)
- **Response convention:** success `{ ok: true, data }` · error `{ ok: false, error }` · proper HTTP status codes
- **Auth:** protected routes require `Authorization: Bearer <token>`

> Source of truth for both lanes. **Any change → post in `#api-contract` with @mention BEFORE merging.**
> **Auth, Users, Movies, Collections, and AI are all live** (see the tables below). **Wheel** has **no server endpoint** — the Spin-the-Wheel state currently persists client-side in `localStorage` (the `collections.savedWheel` field is reserved but unused).

## Client screens ↔ API map

The client is a **static multi-page app** (separate `.html` files, params via query string), so the nested paths below are the **navigation hierarchy**, not literal browser URLs. The API stays **flat** — a collection has a unique id and its owner is taken from the JWT, so routes never nest under `/users/:id`.

| Screen (nav hierarchy) | Page (today) | Backing API | Status |
|---|---|---|---|
| `/login` | `login.html` | `POST /api/auth/login` | ✅ wired |
| `/signup` | `signup.html` | `POST /api/auth/signup` | ✅ wired |
| `/home` | `index.html` | `GET /api/movies/search`, `/genres`, `/providers`, `/people/*` | ✅ wired |
| `/movies/:movieId` | `movie.html?id=` | `GET /api/movies/:id` | ✅ wired |
| `/about` | `about.html` | — (static) | ✅ |
| `/profile/:userId` | `profile.html` | `GET /api/auth/me` (own) · `GET /api/users/:id` (others) | ✅ own / ⛔ others = deferred (social) |
| `/profile/:userId/collections/:collectionId` | `collection.html?id=` | `GET /api/collections/:id` | ✅ wired |
| `…/collections/:collectionId/add-movie` | Add-to-Collection modal | `POST /api/collections/:id/movies` | ✅ wired |
| `…/collections/:collectionId/picker` | `picker.html?collection=` | `GET /api/collections/:id` | ✅ wired |
| `…/picker/wheel` | `wheel.html?collection=` | — (client-side `localStorage`) | ⛔ no server endpoint |
| `…/picker/let-ai-choose` | `picker.html` (AI mode) | `POST /api/ai/picker` | ✅ wired |
| `/search` (AI) | search UI / modal | `POST /api/ai/search` | ✅ wired |
| `…/collections/:collectionId/enhance` | *(TODO page)* | `POST /api/ai/enhance/:id` | ✅ backend ready, FE TODO |

Deferred routes implied by the map but **not** yet in the tables below: `GET /api/users/:id` (public profile of another user — social, deferred).

## Auth  ✅ implemented (S4)
| Method | Path | Body | Returns (`data`) | Auth |
|---|---|---|---|---|
| POST | `/api/auth/signup` | `{name,email,username,password,dateOfBirth}` | `{token, user}` | — |
| POST | `/api/auth/login` | `{emailOrUsername,password}` | `{token, user}` | — |
| GET | `/api/auth/me` | — | `{user}` | Bearer |

- All three use the standard envelope: success `{ ok:true, data:{…} }`, failure `{ ok:false, error }`.
- `user` is the **safe** shape — `{ id, username, email, name, bio, dateOfBirth, avatarUrl, countryCode, createdAt }`. `passwordHash` is never returned.
- `token` is a JWT (`{ id }`, 7-day expiry); the client stores it and sends `Authorization: Bearer <token>` on protected routes.
- **signup** → `201`; validates all fields, rejects a duplicate `email`/`username` with `400`, then **seeds the 3 default collections** (Favorites, Already Watched, Watchlist; `isDefault:true`).
- **login** → `401 Invalid credentials` on either a bad identifier or a bad password (never reveals which).
- **me** → `401` when the `Authorization` header is missing/malformed, the token is invalid/expired, or the user no longer exists.

## Users
| Method | Path | Body | Returns (`data`) | Auth | Status |
|---|---|---|---|---|---|
| PATCH | `/api/users/me` | `{ bio?, name?, avatarUrl?, countryCode? }` | `{ user }` | Bearer | ✅ implemented |
| GET | `/api/users/:id` | — | `{ user }` (public profile) | — | ⛔ deferred (social) |

- **PATCH `/me`** updates the **signed-in** user's own profile — whitelist only; it never changes `email`/`username`/`passwordHash`. `bio` is trimmed and capped at 200 chars. Returns the updated safe `user`. `400` on an empty/invalid body.

## Movies (TMDB-backed, cached)
| Method | Path | Query / Params | Returns | Status |
|---|---|---|---|---|
| GET | `/api/movies/search` | `q, genre, yearFrom, yearTo, minRating, minVotes, language, with_cast, with_crew, sort, page` | `{ ok:true, data:[movie] }` | ✅ implemented |
| GET | `/api/movies/random` | — | `{ ok:true, data:{movie} }` | ✅ implemented |
| GET | `/api/people/search` | `q` | `{ ok:true, data:[{id,name,profile_path,known_for_department}] }` | ✅ implemented |
| GET | `/api/people/popular` | `page` | `{ ok:true, data:[{id,name,profile_path,known_for_department}] }` — pre-fills actor/director dropdowns; filtered to mostly-English `known_for` (US/Hollywood bias) | ✅ implemented |
| GET | `/api/genres` | — | `{ ok:true, data:[{id,name}] }` | ✅ implemented |
| GET | `/api/providers` | — | `{ ok:true, data:[{provider_id,provider_name,logo_path,display_priority}] }` | ✅ implemented |
| GET | `/api/movies/:tmdbId` | `tmdbId` | `{ ok:true, data:{movie detail} }` | ✅ implemented |

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

**Filtering by person:** resolve a name via `GET /api/people/search`, then pass the chosen `id` to
`/api/movies/search?with_cast=<id>` (actor) or `/api/movies/search?with_crew=<id>` (director).

> **History:** the server originally exposed prefix-less proxy twins (`/movies`, `/movies/random`,
> `/movies/search`) that returned named payloads. They were **removed** once the client moved fully
> to the `/api` + `{ ok, data }` routes above — there are now no non-`/api` routes except `GET /` (health).

## Collections (Bearer)  ✅ implemented (S5)
| Method | Path | Body | Returns (`data`) |
|---|---|---|---|
| GET | `/api/collections` | — (query `?isDefault=true\|false`) | `[card]` — the caller's lists, defaults first |
| POST | `/api/collections` | `{ name? }` | `{card}` (**201**) — new empty list; auto-names `My Collection N` if blank |
| GET | `/api/collections/:id` | — | `{full}` — collection + its movies ← **complex query #2** (join items↔movies) |
| PATCH | `/api/collections/:id` | `{ name?, isPublic?, sort? }` | `{card}` — inline rename + Publish/Unpublish + remembered sort (`sort` is one of the 6 sort keys) |
| DELETE | `/api/collections/:id` | — | `{ deleted: true, id }` |
| POST | `/api/collections/:id/movies` | `{ tmdbId }` | `{full}` |
| DELETE | `/api/collections/:id/movies/:tmdbId` | — | `{full}` |

- **All routes require Bearer.** Ownership comes from the JWT (routes never nest under `/users/:id`). Mutating routes are **owner-only** and return **404** (never 403) for someone else's collection, so a private collection's existence isn't leaked.
- **`card`** (list / create / patch): `{ id, name, isDefault, isPublic, posterUrl, movieCount, movieIds, posters, likesCount, savesCount, author, isOwner, createdAt }`. `posters` = bare TMDB paths for the first ≤4 movies (client builds the 2×2 collage + prefixes the CDN); `movieIds` = the **full** id list for cheap membership checks (drives the home/movie heart & eye); `posterUrl` (custom cover) overrides the collage when set.
- **`full`** (`GET /:id`, add/remove movie): the `card` identity fields **plus** `authorId` and `movies: [{ id, title, poster_path, vote_average, release_date, releaseYear, addedAt, sortOrder }]` — the joined `movies` cache in stored order, TMDB-shaped (same normaliser as the feed). *(Note: collection movie objects do **not** carry `genre_ids`/`provider_ids`.)*
- **`?isDefault`** — `true` → only the 3 default lists (Favorites / Already Watched / Watchlist); `false` → only custom lists; omitted → all of the caller's lists. The heart/eye buttons call it with `?isDefault=true`.
- **`GET /:id`** is **login-gated** (guests → 401, client redirects to login). A logged-in **non-owner** may view a **public** collection in *visitor mode* (`isOwner:false`); a **private** one is owner-only (else 404).
- **Default lists** (`isDefault:true`) can't be **renamed** or **deleted** (`400`), but their **visibility can** be toggled. `POST /:id/movies` is **idempotent** (re-adding a movie is a no-op) and warms the `movies` cache so the cover/grid always has a poster.
- **`likesCount` / `savesCount`** are **stubbed at 0** — like/save storage is deferred (Explore). Browsing *other* users' public lists (an Explore feed) has **no endpoint yet** — it needs its own paginated route.

## Wheel (Spin the Wheel persistence) — ⛔ no server endpoint
There is **no** `/api/collections/:id/wheel` route. The Spin-the-Wheel state persists **client-side in `localStorage`**; the `collections.savedWheel` field (`[String]`) is reserved for a future server-side pass but nothing reads or writes it yet.

## AI (Gemini-backed, Bearer)  ✅ implemented
Three AI features powered by Google Gemini (`@google/generative-ai`, model `gemini-2.5-flash`). All are **login-gated** (Bearer). Gemini is configured for **JSON-only** output (`responseMimeType: "application/json"` + a strict per-feature schema prompt), so responses are pure parseable JSON — never markdown/prose. Gemini only **ranks/suggests**; every returned record is re-resolved server-side against our own data (collection movies for the picker, TMDB for search/enhance), so the API never returns titles the model invented.

| Method | Path | Body / Params | Returns (`data`) |
|---|---|---|---|
| POST | `/api/ai/picker` | `{ collectionId, prompt, count }` | `[movieCard + reason]` — picks **from the user's own collection** |
| POST | `/api/ai/search` | `{ query }` | `[tmdbMovie]` — up to 50 real TMDB movies for a natural-language query |
| POST | `/api/ai/enhance/:id` | `:id` (collectionId) | `[tmdbMovie + reason]` — exactly 3 recs **not** already in the collection |

- **`POST /api/ai/picker`** ("Let AI Choose") — **owner only** (the collection must belong to the caller; non-owner/missing → `404`). `prompt` is the natural-language ask (e.g. `"a scary movie before the 2000s"`); `count` is clamped to **1–3** and to the collection size. Returns the chosen movies as TMDB-shaped cards (`{ id, title, poster_path, vote_average, release_date, releaseYear, reason }`) in the AI's ranked order. Ids the model returns that aren't actually in the collection are discarded. `400` if the collection has no movies.
- **`POST /api/ai/search`** ("AI Search") — `query` is required (`400` if blank). Gemini proposes up to 50 `{title, year}`; each is resolved via TMDB `/search/movie` (year-preferred match, concurrency-capped), misses/duplicates dropped. `data` is **raw TMDB movie objects** — the same shape as `GET /api/movies/search`, so the existing client normaliser handles it. No `reason` field (it's a results grid). Note: results are **not** persisted to the movies cache.
- **`POST /api/ai/enhance/:id`** ("Enhance Collection") — **owner only** (same `404` rule as picker). Returns exactly **3** movies the user doesn't already have, each as a raw TMDB object **plus** a `reason` string. Titles already in the collection are excluded both in the prompt and by a post-filter on TMDB id. *(Backend ready; frontend lands later.)*
- **Errors:** `400` (bad/missing input) · `401` (no/invalid token) · `404` (collection missing or not the caller's) · `500` (`GEMINI_API_KEY` not configured) · `502` (Gemini returned malformed/non-JSON, or an upstream/quota failure) · `504` (Gemini call exceeded the timeout, default 20s). Requires `GEMINI_API_KEY` in the server env (see `.env.example`); optional `GEMINI_MODEL` / `GEMINI_TIMEOUT_MS` overrides.

## Error shape
`{ ok: false, error: "message" }` with status **400** (bad input) · **401** (no/invalid token) · **404** (not found) · **500** (server) · **502** (bad upstream / AI parse) · **504** (upstream timeout).
