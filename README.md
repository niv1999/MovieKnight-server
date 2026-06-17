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
```

> Get the key from themoviedb.org → **Settings → API → "API Key (v3 auth)"**.

## Run

```bash
npm start
```

The server listens on **http://localhost:3000**. (`npm run dev` restarts on file
changes via Node's built-in `--watch`.)

## Endpoints

CORS is open to all origins (GET + `Accept` header), so it works from a static
server or `file://`.

| Method & path                | TMDB source                | Returns                          |
| ---------------------------- | -------------------------- | -------------------------------- |
| `GET /movies`                | `/movie/popular` — or `/discover/movie` when filters are present | `{ movies: [...] }` |
| `GET /movies/search?query=`  | `/search/movie`            | `{ movies: [...] }` (empty `query` → `[]`) |
| `GET /genres`                | `/genre/movie/list`        | `{ genres: [{ id, name }] }`     |
| `GET /providers`             | `/watch/providers/movie` (US) | `{ providers: [{ provider_id, provider_name, logo_path, display_priority }] }` |

### Filtering `/movies`

When any of these TMDB-native query params are present, `/movies` switches to
`/discover/movie` and forwards them as-is (otherwise it returns the popular feed):

| Param                       | Example        | Notes                                  |
| --------------------------- | -------------- | -------------------------------------- |
| `with_genres`               | `28,12`        | comma-separated genre IDs              |
| `with_watch_providers`      | `8|9`          | pipe-separated provider IDs; `watch_region` defaults to `US` if omitted |
| `watch_region`              | `US`           | sent alongside `with_watch_providers`  |
| `primary_release_date.gte`  | `2010-01-01`   |                                        |
| `primary_release_date.lte`  | `2010-12-31`   |                                        |
| `vote_average.gte`          | `7`            | adds `vote_count.gte=50` by default so low-vote titles don't surface |
| `sort_by`                   | `popularity.desc` | optional; frontend doesn't send it yet |
| `page`                      | `2`            | 20 results/page; clamped to an integer 1–500, defaults to 1. Works for the popular feed too. |

Movie objects keep TMDB's raw field names (`title`, `vote_average`, `popularity`,
`release_date`, `poster_path`). `poster_path` / `logo_path` are left as TMDB's
bare `/abc.jpg` paths — the frontend prefixes `https://image.tmdb.org/t/p/w500`.

Non-2xx responses from TMDB are passed through with their status code and an
`{ "error": "..." }` body.

## Deploying to Render (later)

Not required for local development. When ready:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment:** set `TMDB_API_KEY` in the Render dashboard (do **not** commit `.env`).
- Render provides its own `PORT` env var, which `index.js` already honors.
- Point the frontend's `MovieAPI` base URL at the deployed Render URL.
