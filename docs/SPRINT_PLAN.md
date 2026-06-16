# MovieKnight — 2-Week MVP Sprint Plan (due Tue June 30, 2026)

## Links
- Client repo: https://github.com/MatanShtar/MovieKnight
- Server repo: https://github.com/niv1999/MovieKnight-server
- Figma: https://www.figma.com/design/gYRNW93jiuFABiCGAxcuY1/MovieKnight
- This is the canonical plan (the brain). Discord `#board` tracks live status.

## Context

University web-dev final project. Grade ≥60 required to pass. Two devs (Niv & Matan), part-time, ~14 days.
We already have a strong **vanilla HTML/CSS/JS frontend prototype** (home, login, signup, profile, picker, wheel) with custom CSS that closely matches the Figma. It is currently **static**: hardcoded/JSON data, `localStorage` mock auth (`admin`/`1234`), many `Coming Soon!` stubs.

The course **requires a deployed, dynamic site**: vanilla client + **Node/Express** server + **database** + RESTful **full CRUD** + ≥2 complex queries + external public API + an embedded JS library + Postman collection + meaningful Git history across two repos. Stack is **locked to what was taught** (no frameworks).

This plan defines a **minimal-but-complete MVP** that hits every course requirement and grading line, deferring the rest of the SRS.

Fixed facts from the lectures:
- **Deploy = Render** (course intro names Moodle + GitHub + FTP + Render).
- Taught server: CommonJS `require`, Express (`Router`, `express.json()`, `req.params/query/body`, `res.status().json()`), `cors`, `dotenv`, `morgan`; `index.js` + `controllers/` + `routes/` + `db_connection.js`.
- Taught client: full ES6, DOM + `addEventListener`, forms + `preventDefault` + in-page errors, `fetch` + async/await.
- **MongoDB taught Thursday June 18** → DB work starts after that.
- **Not taught (we add, documented):** auth (bcryptjs + JWT), deployment specifics.
- Keep custom CSS (not Bootstrap); Toastify satisfies "embed a JS library".

## 1. MVP Scope — IN
Auth/user-mgmt (signup/login/logout/guest, bcryptjs hash, JWT, seed default collections) · Discovery/Home (TMDB search+browse, filter, sort, cached) · Movie Details page (NEW) · Collections (CRUD + collection page) · Profile (real data) · **About page** (NEW — overview + devs + required TMDB attribution) · **Spin the Wheel** (flagship) · cross-cutting states + in-page messages · Deploy (Render) · submission artifacts.

### DEFERRED → see §11 prioritized backlog
Explore+social+Trending · Chopping Block · Preferences · account settings · avatar upload · dynamic badges · 404 · drag-&-drop · **one simple AI feature (first extra if time)**. Keep "Coming Soon" placeholders (Lecturer Q1).

## 2. Key decisions
- **Complexity bar:** easiest-robust + best-practice, buildable by two 2nd-year CS students.
- **DB = MongoDB document model** — 3 collections (`users`, `movies` TMDB-cache, `collections` with embedded `items[]` + `savedWheel`). See DATA_MODEL.md.
- **Data layer = Mongoose** (ODM; simplest best-practice).
- **Auth = bcryptjs + JWT** in localStorage, verified by one middleware.
- **External API = TMDB**, proxied server-side (key in `.env`).
- **Deploy:** DB on Atlas (cloud, separate) · backend on Render Web Service (`cors`) · frontend on Render Static / GitHub Pages; client `fetch` uses one `API_BASE_URL`.
- **JS library:** Toastify (+ optional canvas-confetti for the wheel win).
- **2 complex queries:** (1) movie search w/ filters+sort; (2) collection-with-movies aggregation.

## 3. Repos
- Client = existing **MovieKnight** (no rename). Server = **MovieKnight-server**.
- Local: both side-by-side under `…/Web/`.
- Brain = Discord board + `docs/` here (SPRINT_PLAN, API_CONTRACT, DATA_MODEL, SUBMISSION_CHECKLIST).

## 4. Task bundles (IDs are stable; unassigned)

**Phase 0 — Foundations, no DB (Tue 6/16–Wed 6/17)**
- X1 · Repos + scaffolding + Discord. Dep: —
- X2 · API contract + data model docs (pair). Dep: X1
- S1 · Express skeleton on stub data. Dep: X2
- S2 · TMDB proxy (`/api/tmdb/...`, key in .env). Dep: S1
- C1 · New page shells (movie-details, collection) + Figma. Dep: —
- C8 · About page + TMDB attribution (static filler). Dep: —
- X3 · Placeholder audit. Dep: —

**Phase 1 — DB + auth (Thu 6/18 eve–Sat 6/20, after Mongo lecture)**
- S3 · Mongo connect + models. Dep: S1, Mongo lecture
- S4 · Auth API (bcryptjs + JWT) + seed default collections. Dep: S3
- S5 · Collections CRUD API (+ add/remove movie, cache-on-add). Dep: S3, S2
- S6 · Movies/search API + 2 complex queries. Dep: S3, S2

**Phase 2 — Wire frontend ↔ API (Sun 6/21–Wed 6/24)**
- C2 · Auth wiring (replace mock). Dep: S4
- C3 · Home discovery (TMDB + filters + sort). Dep: S6
- C4 · Movie details page. Dep: S5, S6, C1
- C5 · Collections UI (profile + collection page). Dep: S5, C1
- X3b · Tidy placeholders + Figma. Dep: X3

**Phase 3 — Flagship + polish (Thu 6/25–Fri 6/26)**
- C6 · Spin the Wheel end-to-end. Dep: S5, S6
- X4 · States pass (loading/empty/error). Dep: C2–C6

**Phase 4 — Deploy + verify (Sat 6/27–Sun 6/28)**
- S7 · Deploy backend (Render) + Postman. Dep: S4–S6
- C7 · Deploy frontend + point at live API. Dep: S7, C2–C6

**Phase 5 — Submission (Mon 6/29–Tue 6/30)**
- X5 · Docs + demo dry-run. Dep: C7
- X6 · Submit (Moodle). Dep: X5

## 5. Delegation
Two swimlanes (pick your own): **Lane A Server&Data** (X1, S1–S7) · **Lane B Client&Integration** (C1–C8, X3/X3b). Pair on X2, the Thu kickoff, X4/C7, demo. Anti-block rule: lock API_CONTRACT early; Lane B builds vs stubs. Small frequent commits from both (graded).

## 6. Schedule
Tue X1/X2/C1 · Wed S1/S2/C1/X3 · **Thu Mongo→S3** · Fri S4/S5 · Sat S5/S6 · Sun C2/C3 · Mon C3/C4 · Tue C5 · Wed X3b/C8/buffer · Thu C6 · Fri X4 · Sat S7 · Sun C7 · Mon X5 · **Tue submit X6**.
Cut-line if behind: drop stretch → trim filters → wheel read-only → never cut auth/CRUD/deploy/2 queries.
If ahead: §11 in order — AI feature first.

## 7. Submission checklist → SUBMISSION_CHECKLIST.md

## 11. Extra backlog (only if MVP done) — priority order
1. ⭐ AI "Let AI Choose" (free Gemini key) — **first extra**
2. Drag-&-drop reorder (SortableJS)
3. Account settings (edit/delete account)
4. 404 page
5. The Chopping Block
6. Preferences page
7. Explore + social + Trending
8. likes/saves · avatar upload · dynamic badges

## 12. Lecturer questions (no kitbag)
1. "Coming Soon" placeholders OK or must remove? 2. bcrypt+JWT OK for user-mgmt? 3. Render OK for both or FTP required? 4. Mongo Atlas + Mongoose OK?

---
*Full prose version maintained alongside; this is the working copy in the repo.*
