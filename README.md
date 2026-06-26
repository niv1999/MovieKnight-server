# MovieKnight — Server

The backend for [MovieKnight](https://movieknight.site): a Node/Express API that
powers the movie browser, user accounts, collections, and AI helpers.

It does three jobs:

1. **Proxies the [TMDB v3 API](https://developer.themoviedb.org/reference/intro/getting-started)** so the TMDB key stays server-side and never reaches the browser.
2. **Stores user data in MongoDB** — accounts (bcrypt + JWT), profiles, and collections (Favorites / Watchlist / Already Watched + custom lists).
3. **Wraps Google Gemini** for the "Let AI Choose", AI Search, and Enhance-collection features, behind a per-user daily quota.

> Part of a university web-dev course project. Stack is intentionally vanilla —
> **CommonJS, no TypeScript, no build step.**

## Quick start

```bash
npm install
cp .env.example .env    # Windows: copy .env.example .env
# ...fill in .env (see below), then:
npm run dev             # nodemon — restarts on file changes
# or: npm start         # plain node, for production
```

The server listens on **http://localhost:3000**. Health check:
`GET /` → `{ ok: true, service: "movieknight-server" }`.

The server **boots even with an empty `.env`** — a failed Mongo connection is
non-fatal (the TMDB proxy still serves), and the AI routes simply return an error
until `GEMINI_API_KEY` is set. Auth and collections need `MONGODB_URI` +
`JWT_SECRET` to actually work.

## Environment (`.env`)

Copy `.env.example` and fill in real values. **Never commit `.env`** (it's gitignored).

| Var | Required? | Notes |
| --- | --- | --- |
| `TMDB_API_KEY` | yes | TMDB **v3** key (themoviedb.org → Settings → API → "API Key (v3 auth)"). Server-side only. |
| `MONGODB_URI` | for accounts | MongoDB Atlas connection string. |
| `JWT_SECRET` | for accounts | Long random string used to sign auth tokens. |
| `GEMINI_API_KEY` | for AI | Google Gemini key (aistudio.google.com → "Get API key"). |
| `PORT` | no | Defaults to `3000`. On Render, leave **unset** — the platform injects it. |
| `CORS_ORIGINS` | no | Comma-separated allowlist that overrides the built-in defaults. |
| `AI_DAILY_LIMIT` | no | Per-user daily AI-action limit (default `5`). |
| `GEMINI_MODEL` / `GEMINI_TIMEOUT_MS` | no | Model + per-call timeout overrides. |

**CORS** is an allowlist, not wide open: `movieknight.site` (+ `www`) and the
common local dev origins (`:5500` Live Server, `:8000`, `:3000`). Non-browser
clients (curl/Postman/health checks) are always allowed. Extend it via
`CORS_ORIGINS`.

## Architecture

A standard layered Express app — `routes → controllers → services / models` —
with a thin entry point and one shared error funnel.

```
index.js              app bootstrap: middleware, CORS, mounts routers, 404 + error handlers
routes/               thin path → controller maps (auth, users, movies, people, catalog, collections, ai)
controllers/          request handling + validation, one per resource
services/
  tmdb.js             tmdb(path, params) — injects the key, forwards to api.themoviedb.org/3
  movieCache.js       Mongo "fetch once, store forever" movie cache
  gemini.js           Gemini client (JSON-mode prompts)
  aiQuota.js          per-user daily AI quota
middleware/auth.js    JWT verification (requireAuth / optionalAuth)
models/               Mongoose schemas: User, Movie, Collection, FeedCache
utils/route.js        wraps async handlers so errors funnel to the central handler
```

**One response contract.** Every `/api/*` route returns the envelope
`{ ok: true, data }` on success or `{ ok: false, error, code? }` on failure, with
a proper HTTP status. User-facing errors are **generic** — internal/upstream
detail (including anything TMDB-specific) is logged server-side only, never
returned to the client.

## API

All routes are under `/api` and return the `{ ok, data }` / `{ ok, error }`
envelope described above. The table below is a quick map of the surface.

| Method & path | What it does |
| --- | --- |
| `GET /api/movies/search` | Movie feed / search. Empty `q` → popular discover feed; `q` present → text results. Filters + sort. |
| `GET /api/movies/random` | One random recognizable movie from the popular feed (`?pages=N`, default 50). |
| `GET /api/movies/:tmdbId` | Full movie detail. |
| `GET /api/people/search` · `/people/popular` | TMDB people search + popular-people prefill. |
| `GET /api/genres` · `/api/providers` | TMDB genre list + US watch-provider list. |
| `POST /api/auth/signup` · `/login` · `GET /api/auth/me` | Auth: bcrypt + JWT. Signup seeds the 3 default lists. |
| `PATCH /api/users/me` | Update own profile (bio / avatar / name / country). |
| `GET/POST/PATCH/DELETE /api/collections …` | Collection CRUD, add/remove movie, publish/unpublish. |
| `GET/PUT /api/collections/:id/wheel` | Persist the saved Spin-the-Wheel state. |
| `POST /api/ai/picker` · `/search` · `/enhance/:id` · `GET /usage` | Gemini helpers (login-gated, daily-quota limited). |

**Semantic params.** `/api/movies/search` takes app-level params the server maps
onto TMDB's native ones: `q`, `genre`, `yearFrom`/`yearTo`, `minRating`,
`minVotes`, `language`, `with_cast`/`with_crew`, `providers` (+ `watch_region`),
`certification` (+ `certification_country`), `sortBy`, `page`.

Movie objects keep TMDB's raw field names (`title`, `vote_average`, `popularity`,
`release_date`, `poster_path`). Image paths stay bare (`/abc.jpg`) — the frontend
prefixes the TMDB CDN base.

## Data model

Document-style MongoDB. Items and the saved wheel are **embedded**, not joined
(Mongo-idiomatic).

- **`users`** — auth + profile. Stores `passwordHash` only (bcrypt); a `publicUser` allow-list keeps the hash server-side.
- **`movies`** — TMDB cache, "fetch once, store forever". `_id` **is** the numeric TMDB id.
- **`collections`** — owned by a user; embeds `items[]` and `savedWheel[]`. Three defaults per user (Favorites / Already Watched / Watchlist).
- **`feedcaches`** — caches the popular-feed pages.

## Deploying (Render)

- **Build:** `npm install`  ·  **Start:** `npm start`
- Set `TMDB_API_KEY`, `MONGODB_URI`, `JWT_SECRET`, `GEMINI_API_KEY` in the dashboard — do **not** commit `.env`.
- Leave `PORT` unset; Render injects it and `index.js` honors it.
- Point the frontend at the deployed URL (the client auto-selects it when not on localhost — see the client's `js/core/api.js`).
