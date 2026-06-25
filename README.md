# MovieKnight TMDB Proxy

A small Node/Express backend that proxies the [TMDB v3 API](https://developer.themoviedb.org/reference/intro/getting-started)
for the MovieKnight frontend. All TMDB calls happen server-side so the API key
is never exposed to the browser.

## Setup

```bash
npm install
```

Create a `.env` file in this folder (copy `.env.example`) and add your TMDB **v3**
API key:

```
TMDB_API_KEY=your_tmdb_v3_api_key_here
PORT=3000
MONGODB_URI=your_mongo_db_uri
```

> Get the key from themoviedb.org → **Settings → API → "API Key (v3 auth)"**.

## Run

```bash
npm start
```

The server listens on **http://localhost:3000**. (`npm run dev` restarts on file
changes via Node's built-in `--watch`.)

## Endpoints

All routes live under `/api` and return the envelope `{ ok: true, data }` (success) or
`{ ok: false, error, code? }` (failure) with a proper HTTP status. CORS is open to all
origins, so the static client works from any host or `file://`. The only non-`/api`
route is `GET /` — a health check returning `{ ok: true, service: "movieknight-server" }`.

| Method & path | Notes |
| --- | --- |
| `GET /api/movies/search` | Movie feed / search. Empty `q` → popular discover feed; `q` present → text-relevance results. (Complex query #1: filters + sort.) |
| `GET /api/movies/random` | One random but recognizable movie from the popular feed. `?pages=N` optional (default 50). |
| `GET /api/movies/:tmdbId` | Full movie detail. |
| `GET /api/people/search` · `/people/popular` | TMDB people search (`?q=`) + popular-people pre-fill. |
| `GET /api/genres` · `/api/providers` | TMDB genre and US watch-provider lists. |
| `POST /api/auth/signup` · `/login` · `GET /api/auth/me` | Auth (bcrypt + JWT). |
| `PATCH /api/users/me` | Update own profile (bio / avatar / name / country). |
| `… /api/collections …` | Collection CRUD, add/remove movie, and the saved wheel (`GET/PUT /api/collections/:id/wheel`). |
| `POST /api/ai/picker` · `/search` · `/enhance/:id` | Gemini-backed helpers (daily-quota limited). |

`/api/movies/search` takes **semantic** params the server maps to TMDB (not raw TMDB
param names): `q`, `genre`, `yearFrom`/`yearTo`, `minRating`, `minVotes`, `language`,
`with_cast`/`with_crew`, `providers` (+ `watch_region`), `certification`
(+ `certification_country`), `sortBy`, `page`.

Movie objects keep TMDB's raw field names (`title`, `vote_average`, `popularity`,
`release_date`, `poster_path`); `poster_path` / `logo_path` stay as bare `/abc.jpg`
paths — the frontend prefixes `https://image.tmdb.org/t/p/w500`.

**Full, authoritative contract (every route, body, response, status code):
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).**

## Deploying to Render (later)

Not required for local development. When ready:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment:** set `TMDB_API_KEY` in the Render dashboard (do **not** commit `.env`).
- Render provides its own `PORT` env var, which `index.js` already honors.
- Point the frontend's `MovieAPI` base URL at the deployed Render URL.
