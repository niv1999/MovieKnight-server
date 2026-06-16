# Dev Onboarding — MovieKnight

Get a local dev environment running across both repos. ~15 minutes. No prior backend setup needed.

## 1. Install the tools
- **Node.js LTS (v18 or newer)** — https://nodejs.org  *(v18+ matters: the TMDB proxy uses Node's built-in `fetch`)*. This also installs `npm`.
- **Git** — https://git-scm.com
- **VS Code** — https://code.visualstudio.com  *(+ the "Live Server" extension to serve the client)*
- **Postman** — https://www.postman.com/downloads/  *(to test the API)*
- *(optional)* **Claude Code** for AI-assisted dev.

> No local MongoDB install — we use **MongoDB Atlas** (cloud).

Check it worked:
```bash
node -v    # v18.x or newer
npm -v
git --version
```

## 2. Clone both repos side-by-side
Keep them in one parent folder so they sit next to each other:
```bash
mkdir MovieKnight-Project && cd MovieKnight-Project
git clone https://github.com/MatanShtar/MovieKnight.git          # client (frontend)
git clone https://github.com/niv1999/MovieKnight-server.git      # server (API)
```

## 3. Run the server (API)
```bash
cd MovieKnight-server
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run dev                 # http://localhost:5000  (auto-reloads on save)
```
- ✅ **It boots on stub data even with an empty `.env`** — `db_connection.js` skips Mongo while `MONGODB_URI` is still the placeholder. So you can run it right now.
- **Health check:** open http://localhost:5000/ → `{"ok":true,"data":"MovieKnight API is running 🎬"}`
- **Stub endpoint:** http://localhost:5000/api/movies/search
- Fill `.env` as values arrive: `TMDB_KEY` (after S2 — get your own free key at themoviedb.org or use the team's), `MONGODB_URI` (after S3 — shared privately by the team, **never** in Git), `JWT_SECRET` (any long random string). **Never commit `.env`.**

## 4. Run the client (frontend)
Plain HTML/CSS/JS — **no install**. Just serve it over http (not `file://`):
- VS Code: right-click `index.html` → **Open with Live Server**, **or**
- ```bash
  cd MovieKnight
  python -m http.server 8000      # then open http://localhost:8000/index.html
  ```
- Until tasks C2/C3 wire it to the API, it still uses local JSON + the mock login (`admin` / `1234`).

## 5. How we work
- **Branch off `main`**, make small + frequent commits, push, open a PR. We're both collaborators on both repos.
- **Pick a task** from the Discord **#board** forum → set its tag to `🔨 Doing` + your owner tag. Blocked cards list their unblockers in the body.
- **Read first:** [`docs/SPRINT_PLAN.md`](SPRINT_PLAN.md) · [`docs/API_CONTRACT.md`](API_CONTRACT.md) · [`docs/DATA_MODEL.md`](DATA_MODEL.md). The API contract is the shape both sides build against — flag any change in `#api-contract` before merging.

## Quick troubleshooting
- **`'cp' is not recognized` (Windows):** use `copy .env.example .env`.
- **Port 5000 in use:** set `PORT=5001` in `.env`.
- **`fetch is not defined`:** your Node is older than v18 — upgrade.
- **CORS errors later (deployed):** the server's `CORS_ORIGIN` must match the client's URL.
