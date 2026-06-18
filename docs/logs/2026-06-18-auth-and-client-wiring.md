# Work Log — Auth flow (S4) + client auth wiring (C2) + requirements alignment

**Date:** 2026-06-18
**Author:** Claude (pair session with Niv)
**Scope:** Implement the real auth flow end-to-end (backend S4 + wire the client off the mock), align routes/API with the course requirements PDF, and produce the missing Postman artifact. Server repo: `MovieKnight-server` (`server/`). Client repo: `MovieKnight` (`client/`).

---

## 1. Summary

The fake auth stubs are gone. Signup/login/me are real: bcryptjs-hashed passwords, JWTs the client stores in `localStorage`, and each new user is seeded with the 3 default collections. The client login/signup forms now call the live API (the `admin`/`1234` mock is removed). Everything was tested at every layer (unit HTTP, DB, CORS, and a real headless-browser click-through). Docs and a Postman collection were updated/created to match.

---

## 2. Backend — S4 auth (built to the taught `routes/` + `controllers/` structure)

The repo previously had **everything inline in `index.js`** (a flat TMDB proxy) and no `controllers/`/`routes/`/`middleware/`. The requirements PDF (p.6) and the rubric (folder structure = 5 pts) require the **`index.js` + `routes/` + `controllers/`** split "as taught", so S4 was the right moment to introduce it.

**New files**
- `controllers/authController.js` — `signup`, `login`, `me` + helpers (`publicUser`, `signToken`). bcrypt rounds = 10, JWT TTL = 7d, payload `{ id }`.
- `middleware/auth.js` — `requireAuth`: reads `Authorization: Bearer <token>`, `jwt.verify`, loads the user (`-passwordHash`), sets `req.user`; 401 on any problem.
- `routes/authRoutes.js` — `express.Router()`: `POST /signup`, `POST /login`, `GET /me` (protected). Mounted at `/api/auth`.

**Behaviour**
- `signup` validates `{name,email,username,password,dateOfBirth}`, rejects duplicate email/username (400), hashes the password, creates the user, **seeds Favorites / Already Watched / Watchlist** (`isDefault:true`, best-effort so a seeding hiccup can't strand the account), signs a JWT → `201 { ok:true, data:{ token, user } }`.
- `login` takes `{emailOrUsername,password}`, looks up by email OR username, `bcrypt.compare`, returns `{ token, user }`; **`401 Invalid credentials`** on a bad identifier *or* password (no field leak).
- `me` returns `{ ok:true, data:{ user } }` from `req.user`.
- **`passwordHash` is never returned** — `publicUser()` is an explicit allow-list.

---

## 2a. Whole-API route/controller refactor (same session, follow-up)

After auth, the **inline movie/TMDB routes in `index.js` were moved into the taught layout** too, so the *entire* API is `routes/` + `controllers/` (not just auth). Pure structural move — **behaviour identical**, verified by a 10-route smoke test.

- `services/tmdb.js` — the TMDB client (`tmdb`, `clampPage`, `randInt`) extracted from `index.js`.
- `utils/route.js` — the async error-forwarding wrapper.
- `controllers/movieController.js` — `discover`/`legacyRandom`/`legacySearch` (legacy `/movies…`) + `search`/`random`/`details` (`/api/movies…`) + their helpers (SORTERS, searchSource, pickRandomMovie).
- `controllers/peopleController.js` — `/api/people/search`, `/api/people/popular`.
- `controllers/catalogController.js` — `/api/genres`, `/api/providers`.
- `routes/movieRoutes.js`, `routes/peopleRoutes.js`, `routes/catalogRoutes.js` — thin; mounted at root so each route keeps its full path.
- `index.js` — now ~75 lines: middleware + `app.use(router)` mounts + health + 404/error handler + DB connect. No route logic.

No `/api` response-shape change. The legacy prefix-less `/movies*` routes (unused by the client — verified the only backend fetch is `api.js`'s `request()`, which always prefixes `/api`) were then **removed** entirely: their handlers (`discover`/`legacyRandom`/`legacySearch`) + `DISCOVER_PARAMS`, the 3 route lines, the dead client `MovieAPI.getMovies()`, the Postman "legacy" entries, and the `API_CONTRACT.md` proxy section. The API is now `/api/*`-only (plus `GET /` health). Trade-off noted: `/movies` was the only route with streaming-provider filtering (`with_watch_providers`); re-add it to `/api/movies/search` if Home ever needs provider filters.

---

## 3. Gaps the S4 kickoff didn't mention — found and fixed

These would each have blocked the flow:

| # | Gap | Fix |
|---|---|---|
| 1 | `bcryptjs` + `jsonwebtoken` not installed | `npm install bcryptjs jsonwebtoken` (now in `package.json`) |
| 2 | CORS was **GET-only**, header allow-list was just `Accept` | `methods: [GET,POST,PUT,PATCH,DELETE]`, `allowedHeaders: [Accept, Content-Type, Authorization]` |
| 3 | No JSON body parser → `req.body` undefined on POST | added `app.use(express.json())` |
| 4 | No `JWT_SECRET` | added to `.env` (real 96-hex) + `.env.example` (placeholder + gen command) |
| 5 | 404/error handlers branched on `req.path` (can be rewritten by a sub-router) | switched to `req.originalUrl` so the `{ok,data}`/`{error}` shape stays correct now that a Router is mounted |
| 6 | `API_CONTRACT.md` dev URL said `:5000` | corrected to `:3000` (matches code + client) |

`.gitignore` already excludes `.env` + `node_modules` — confirmed (PDF p.4 requires this; ZIP **does** include `.env`, p.3).

---

## 4. Client — real auth wiring (C2, partial: auth only)

Live client is `client/` (CLAUDE.md's `client/frontend/` path is **stale** — noted for a CLAUDE.md fix). Static multi-page app.

- `js/api.js` — added session storage (`authToken` + `currentUser`), made `request()` attach `Authorization: Bearer` + serialise JSON bodies, added `signup` / `login` / `me` / `logout` / `isLoggedIn` / `getCurrentUser`.
- `js/validation.js` — **removed the `admin`/`1234` mock**; login/signup now call `MovieAPI` with loading state (button disabled + "Logging in…/Creating account…"), success toast, and server-driven inline + toast errors (duplicate-email/username highlights the field). `continueAsGuest` clears the token too.
- `login.html` / `signup.html` — load `js/api.js` (defer) **before** `js/validation.js`.
- `js/common.js` — sign-out now clears the JWT as well as `currentUser`.

In-page messages only (Toastify) — no `alert/confirm/prompt` (PDF p.10).

---

## 5. Decisions made this session

- **Data model (your question):** keep the FK on the child (`collections.userId`) and **index it** (done) — *not* a `user.collections[]` array. The index makes `Collection.find({userId})` a direct lookup; an array would mean dual-writes + drift risk with no transactions. Rationale written into `docs/DATA_MODEL.md`.
- **Client routing (you chose):** keep **multi-page + query params**; your nested route list is the screen-map / nav hierarchy, not literal URLs. Avoids a hand-rolled SPA router that would fight the "no framework / as taught" rubric and the static-host deploy.
- **API path style (you chose):** **flat, owner-from-token** (`/api/collections/:id`) — not nested under `/users/:id`. Matches the existing contract.
- **`getMovies()` is dead code** (nothing calls it; it points at a non-existent `/api/movies`). Left in place, flagged here. All *used* client→API calls already hit implemented routes.
- **`routes.js` deferred to C5:** with multi-page chosen and the collection page not built yet, a URL-builder layer now would be half-empty; add it alongside the collection/picker pages.

---

## 6. Docs / artifacts updated

- `docs/API_CONTRACT.md` — Auth marked ✅ implemented (bodies/returns/status), added **Client screens ↔ API map**, dev port fixed.
- `docs/DATA_MODEL.md` — referencing-direction + index rationale.
- `models/Collection.js` — `userId` indexed.
- `.env` / `.env.example` — `JWT_SECRET`.
- **`docs/postman/MovieKnight.postman_collection.json`** — NEW. Auth (signup/login/me) + all live `/api` movie routes + health/legacy, each with description + sample request + saved success/error examples. Signup/Login auto-save the JWT to `{{token}}`; set `{{baseUrl}}` to repoint at the deployed URL. (PDF p.8 + rubric.)

---

## 7. Testing performed

- **HTTP unit (Node `fetch`, 23 assertions, all green):** health; signup happy path (201, token, user, **no passwordHash**); validation (missing/bad-email/short-pw → 400); duplicate → 400; me with/without/with-bad token (200/401/401); login by email & username; wrong-password & unknown-user → identical 401; `/api` 404 envelope.
- **DB (Mongoose query):** user persisted; `passwordHash` is a real bcrypt hash (`$2…`); **exactly 3 default collections** (Favorites/Already Watched/Watchlist, `isDefault:true`).
- **CORS:** preflight `OPTIONS` → 204 with `Allow-Methods` incl. POST and `Allow-Headers` incl. Content-Type/Authorization; cross-origin POST returns `Access-Control-Allow-Origin: *` + token.
- **Browser (headless Chromium / Playwright):** real login on `login.html` → redirect to `index.html`; token + user in `localStorage`; logged-in shell UI (login btn hidden, profile shown, username rendered); signup page loads `api.js`; **0 console errors** across login/index/signup.

Test account created in Atlas during testing — `username: tester_1781795234704`, `password: secret123` (3 seeded collections). Usable for a Postman/login demo; **purge before submission** (it's junk data in the shared DB).

---

## 8. Requirements compliance (vs `_resources/הגשת פרוייקט הקורס.pdf`)

| Requirement | Status | Note |
|---|---|---|
| Node/Express server, `routes/`+`controllers/` split (p.6) | ✅ for auth | Movie/TMDB routes still inline in `index.js` — see §9 |
| RESTful API + full CRUD (p.6) | ⚠️ partial | Auth done; **Collections CRUD (S5) not built** — this is where Create/Update/Delete come from |
| ≥2 complex queries (p.7) | ⚠️ 1 of 2 | #1 movie search+filter+sort ✅; #2 collection+movies join ⛔ (S5/S6) |
| Clear success + error responses (p.7) | ✅ | `{ok,data}` / `{ok,error}` + proper status codes |
| User management (rubric 10) | ✅ backend + client login/signup | profile data page = C5 |
| Postman collection w/ examples (p.8) | ✅ created | extend with Collections/Wheel when built |
| External API integral (p.9) | ✅ | TMDB, proxied |
| No `alert/confirm/prompt`; no inline `style`; no stray `!important` (p.10) | ✅ auth pages | full audit = X3/X4 |
| Loading / success / error / empty states (p.11) | ✅ auth forms | apply across all server actions in X4 |
| No console errors (p.11) | ✅ verified on auth+home | re-check per page as built |
| Dynamic data from DB, not hardcoded (p.5) | ✅ auth now DB-backed | collections/profile still on local JSON until S5 |
| Deployed, not localhost (p.2) | ⛔ not yet | **S7** — see deploy checklist §10 |
| `.env` in ZIP, never in Git; no `node_modules` in Git (p.3/p.4) | ✅ | `.gitignore` correct |
| Meaningful commits over time (p.4) | ▶ action | commit this work in logical chunks (see §10), not one dump |
| Figma-accurate UI (p.5) | n/a here | design lane |

---

## 9. Gaps / recommended next steps

1. **S5 — Collections CRUD API** (flat: `/api/collections…`) using `requireAuth`. Unlocks full CRUD, complex query #2, the collection page, add-movie, and the picker/wheel data. Highest priority — the rubric's CRUD + 2nd query depend on it.
2. **S6 — Wheel persistence** (`GET/PUT /api/collections/:id/wheel`).
3. ~~Refactor the inline movie/TMDB routes into routes+controllers~~ — ✅ **done this session** (see §2a). Whole API now matches "as taught".
4. **C5 client** — build `collection.html`, wire profile/collections/picker/wheel to S5/S6, add `js/routes.js` screen-map then.
5. **Deferred** — `GET /api/users/:id` (view others' profiles = social) and `POST /api/collections/:id/ai-pick` ("Let AI Choose"). Both out of MVP core.
6. **Cleanup** — remove dead `MovieAPI.getMovies()` (or repoint), and decide provider-filtering on `/api/movies/search` (currently only the dead `getMovies` had it).
7. **CLAUDE.md** says the client lives in `client/frontend/`; it's actually `client/`. Update it.
8. **ONBOARDING.md** still says port 5000 / `TMDB_KEY` / a different health shape — stale; align to 3000 / `TMDB_API_KEY`.

---

## 10. Before deploy (S7) — checklist

- Render backend env vars: **`JWT_SECRET`** (don't reuse the dev one), `MONGODB_URI`, `TMDB_API_KEY`, `PORT`.
- **`NODE_ENV=production` on Render disables Mongoose auto-index** → the `unique` indexes on `users` and the new `userId` index won't build. Run `syncIndexes()` once at startup (or create them in Atlas) so duplicate-account protection actually holds in prod.
- Point the client at the live API: change `API_BASE` in `client/js/api.js`.
- CORS is `origin:"*"` (fine for token-in-header). Lock down later if desired.
- Commit suggestion (meaningful history, p.4): (a) server: deps + auth controller/middleware/routes + index wiring; (b) server: docs + Collection index + Postman; (c) client: api.js auth + validation.js real auth + common.js logout. Then purge the test user.
