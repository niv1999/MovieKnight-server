# MovieKnight — Server (API)

Express + MongoDB (Mongoose) REST API for **MovieKnight**. Pairs with the **client** repo (vanilla HTML/CSS/JS).

## Stack
Node.js · Express · MongoDB Atlas (Mongoose) · JWT auth (`bcryptjs` + `jsonwebtoken`) · TMDB proxy. Deployed on Render.

## Setup
```bash
npm install
cp .env.example .env      # then fill in the values
npm run dev               # http://localhost:5000  (nodemon)
# or:
npm start
```

## Structure
```
index.js            entry — express app, middleware, mounts routes
db_connection.js    Mongoose connection (Atlas)
routes/             one router per resource (auth, movies, collections)
controllers/        request handlers (business logic)
models/             Mongoose schemas (added after the Mongo lecture)
docs/               SPRINT_PLAN · API_CONTRACT · DATA_MODEL · SUBMISSION_CHECKLIST
```

## API
Base path `/api`. Full list in **[docs/API_CONTRACT.md](docs/API_CONTRACT.md)**.
Response convention: success `{ ok: true, data }`, error `{ ok: false, error }`.

> ⚠️ The current handlers return **stub data** so the client can build against the API in parallel (task **S1**).
> Real Mongo models + auth land after Thursday's Mongo lecture (tasks **S3–S6**).

## Environment (see `.env.example`)
`PORT` · `CORS_ORIGIN` · `TMDB_KEY` · `MONGODB_URI` · `JWT_SECRET` — **never commit `.env`**.
