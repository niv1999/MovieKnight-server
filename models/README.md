# models/

Mongoose schemas go here **after Thursday's Mongo lecture** (task **S3**):

- `User.js` — username, email, passwordHash, name, dateOfBirth, avatarUrl, countryCode
- `Movie.js` — TMDB cache (tmdbId as `_id`, title, posters, rating, director, cast, genres…)
- `Collection.js` — userId, name, isPublic, isDefault, embedded `items[]` + `savedWheel[]`

See **../docs/DATA_MODEL.md** for the exact shapes.
