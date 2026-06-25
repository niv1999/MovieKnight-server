// scripts/seed-demo.js — seed the "Yuviverse7" classroom demo user.
//
// Creates (idempotently) a user with the three progression badges (cosmetic mock,
// read by the profile UI by tier), the Figma bio, a custom avatar, and RICH,
// CURATED collection data so the profile + collection pages have plenty to show:
//   • the 3 default lists (Favorites / Already Watched / Watchlist), and
//   • 4 themed custom lists (Horror Night, 90s Gems, Sci-Fi Essentials, Feel-Good
//     Comedies),
// each filled with real, theme-appropriate films. Every movie is resolved against
// TMDB by title+year (so the ids/metadata are real and covers get a real
// poster + backdrop), and the movie's genre ids are stored on the item so the
// collection grid's genre filter actually works.
//
//   cd server && node scripts/seed-demo.js
//
// Safe to re-run: it wipes and recreates only Yuviverse7's own user + collections.

require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("../db_connection");
const User = require("../models/User");
const Collection = require("../models/Collection");
const Movie = require("../models/Movie");
const { tmdb } = require("../services/tmdb");

const USERNAME = "Yuviverse7";
const EMAIL = "yuviverse7@movieknight.site";
const PASSWORD = "Yuviverse7"; // upper+lower+digit, 10 chars
const AVATAR = "assets/images/yuviverse-profile-pic.png";

const BIO =
  "The 7 stands for how many times I watched Rocky this week 🥊\n" +
  "Barbie is overrated #team_oppenheimer\n" +
  "Real men cry 😭";

const BADGES = [
  { name: "Movie Enthusiast", tier: "silver", subtitle: "Silver Tier · 63 movies until Gold" },
  { name: "Old-School Enjoyer", tier: "gold", subtitle: "Gold Tier · 262 / 200 movies" },
  { name: "Collection Master", tier: "bronze", subtitle: "Bronze Tier · 21 collections until Silver" },
];

// Curated collections. `movies` are listed most-iconic-first so the auto-cover
// (first ≤4 items) reads well. Each entry is { t: title, y: release year } and is
// resolved against TMDB search. Sizes satisfy: ≥2 large (>30) and ≥1 medium (>20).
const m = (t, y) => ({ t, y });
const COLLECTIONS = [
  // ----- default lists -----
  {
    name: "Favorites",
    isDefault: true,
    isPublic: false,
    movies: [
      m("The Shawshank Redemption", 1994), m("The Godfather", 1972), m("Pulp Fiction", 1994),
      m("The Dark Knight", 2008), m("Forrest Gump", 1994), m("Fight Club", 1999),
      m("Goodfellas", 1990), m("The Matrix", 1999), m("Interstellar", 2014), m("Parasite", 2019),
    ],
  },
  {
    // LARGE (>30): a broad "stuff I've seen" list across eras/genres.
    name: "Already Watched",
    isDefault: true,
    isPublic: false,
    movies: [
      m("Inception", 2010), m("The Lord of the Rings: The Fellowship of the Ring", 2001),
      m("The Lord of the Rings: The Return of the King", 2003), m("Gladiator", 2000),
      m("Saving Private Ryan", 1998), m("The Departed", 2006), m("Se7en", 1995),
      m("The Silence of the Lambs", 1991), m("Django Unchained", 2012),
      m("The Wolf of Wall Street", 2013), m("Whiplash", 2014), m("The Prestige", 2006),
      m("No Country for Old Men", 2007), m("There Will Be Blood", 2007),
      m("Mad Max: Fury Road", 2015), m("The Social Network", 2010), m("La La Land", 2016),
      m("Joker", 2019), m("1917", 2019), m("Avengers: Infinity War", 2018),
      m("Avengers: Endgame", 2019), m("Spider-Man: Into the Spider-Verse", 2018),
      m("Knives Out", 2019), m("Get Out", 2017), m("A Beautiful Mind", 2001),
      m("Slumdog Millionaire", 2008), m("The Revenant", 2015), m("Shutter Island", 2010),
      m("Catch Me If You Can", 2002), m("Inglourious Basterds", 2009), m("The Truman Show", 1998),
      m("Memento", 2000), m("Toy Story", 1995), m("Coco", 2017),
    ],
  },
  {
    name: "Watchlist",
    isDefault: true,
    isPublic: false,
    movies: [
      m("Dune: Part Two", 2024), m("Oppenheimer", 2023), m("Poor Things", 2023),
      m("Killers of the Flower Moon", 2023), m("Past Lives", 2023), m("Anatomy of a Fall", 2023),
      m("The Holdovers", 2023), m("The Zone of Interest", 2023), m("Perfect Days", 2023),
      m("Challengers", 2024), m("The Brutalist", 2024), m("Civil War", 2024),
    ],
  },
  // ----- themed custom lists -----
  {
    // MEDIUM (>20)
    name: "Horror Night",
    isDefault: false,
    isPublic: true,
    movies: [
      m("Hereditary", 2018), m("The Shining", 1980), m("The Exorcist", 1973), m("Get Out", 2017),
      m("The Conjuring", 2013), m("Midsommar", 2019), m("The Witch", 2015), m("It", 2017),
      m("Halloween", 1978), m("A Nightmare on Elm Street", 1984),
      m("The Texas Chain Saw Massacre", 1974), m("Alien", 1979), m("The Thing", 1982),
      m("Psycho", 1960), m("Scream", 1996), m("It Follows", 2014), m("The Babadook", 2014),
      m("Insidious", 2010), m("Sinister", 2012), m("The Ring", 2002), m("Us", 2019),
      m("The Evil Dead", 1981), m("Saw", 2004), m("Nosferatu", 2024),
    ],
  },
  {
    // LARGE (>30)
    name: "90s Gems",
    isDefault: false,
    isPublic: true,
    movies: [
      m("Pulp Fiction", 1994), m("The Matrix", 1999), m("Fight Club", 1999), m("Goodfellas", 1990),
      m("Jurassic Park", 1993), m("Schindler's List", 1993), m("Forrest Gump", 1994),
      m("The Silence of the Lambs", 1991), m("Se7en", 1995), m("Terminator 2: Judgment Day", 1991),
      m("Saving Private Ryan", 1998), m("The Big Lebowski", 1998), m("Toy Story", 1995),
      m("The Lion King", 1994), m("Reservoir Dogs", 1992), m("Trainspotting", 1996),
      m("Heat", 1995), m("American Beauty", 1999), m("The Sixth Sense", 1999),
      m("Good Will Hunting", 1997), m("Titanic", 1997), m("Braveheart", 1995), m("Fargo", 1996),
      m("The Truman Show", 1998), m("Groundhog Day", 1993), m("The Shawshank Redemption", 1994),
      m("Aladdin", 1992), m("Beauty and the Beast", 1991), m("Unforgiven", 1992),
      m("L.A. Confidential", 1997), m("The Usual Suspects", 1995), m("Casino", 1995),
      m("Magnolia", 1999),
    ],
  },
  {
    // MEDIUM (>20)
    name: "Sci-Fi Essentials",
    isDefault: false,
    isPublic: true,
    movies: [
      m("Blade Runner 2049", 2017), m("Blade Runner", 1982), m("2001: A Space Odyssey", 1968),
      m("Star Wars", 1977), m("The Empire Strikes Back", 1980), m("Alien", 1979), m("Aliens", 1986),
      m("The Terminator", 1984), m("Terminator 2: Judgment Day", 1991), m("The Matrix", 1999),
      m("Interstellar", 2014), m("Inception", 2010), m("Arrival", 2016), m("Dune", 2021),
      m("Dune: Part Two", 2024), m("Ex Machina", 2014), m("District 9", 2009), m("Gravity", 2013),
      m("Back to the Future", 1985), m("E.T. the Extra-Terrestrial", 1982),
      m("Children of Men", 2006), m("Minority Report", 2002),
    ],
  },
  {
    name: "Feel-Good Comedies",
    isDefault: false,
    isPublic: false,
    movies: [
      m("The Grand Budapest Hotel", 2014), m("Superbad", 2007), m("The Hangover", 2009),
      m("Groundhog Day", 1993), m("Ferris Bueller's Day Off", 1986), m("School of Rock", 2003),
      m("21 Jump Street", 2012), m("Anchorman: The Legend of Ron Burgundy", 2004),
      m("Bridesmaids", 2011), m("Little Miss Sunshine", 2006), m("The Big Lebowski", 1998),
      m("Booksmart", 2019), m("Game Night", 2018), m("Mrs. Doubtfire", 1993),
    ],
  },
];

// Upsert a movie record from a TMDB object (search result OR /movie/:id response).
async function cache(mv) {
  if (!mv || mv.id == null) return false;
  await Movie.updateOne(
    { _id: mv.id },
    {
      $set: {
        title: mv.title || mv.original_title || "",
        releaseYear: mv.release_date ? Number(String(mv.release_date).slice(0, 4)) || null : null,
        releaseDate: mv.release_date ? new Date(mv.release_date) : null,
        posterPath: mv.poster_path || null,
        backdropPath: mv.backdrop_path || null,
        overview: mv.overview || "",
        rating: mv.vote_average ?? null,
        popularity: mv.popularity ?? null,
        lastUpdated: new Date(),
      },
      $setOnInsert: { fullDetails: false },
    },
    { upsert: true }
  );
  return true;
}

// Resolve a { title, year } to a real TMDB movie via search, cache it, and return
// { id, genre_ids }. Prefers the result whose release year matches; falls back to
// a yearless search, then to the top hit. Returns null if nothing matches.
async function resolve(title, year, cached) {
  const search = async (params) => {
    try {
      const data = await tmdb("/search/movie", { include_adult: "false", ...params });
      return data.results || [];
    } catch (err) {
      console.warn(`  ! search failed "${title}": ${err.message}`);
      return [];
    }
  };

  let results = await search({ query: title, primary_release_year: year });
  if (!results.length) results = await search({ query: title });
  if (!results.length) {
    console.warn(`  ! no TMDB match for "${title}" (${year})`);
    return null;
  }

  let pick = results[0];
  if (year) {
    const exact = results.find((r) => (r.release_date || "").slice(0, 4) === String(year));
    if (exact) pick = exact;
  }

  if (!cached.has(pick.id)) {
    await cache(pick);
    cached.add(pick.id);
  }
  return { id: pick.id, genre_ids: Array.isArray(pick.genre_ids) ? pick.genre_ids : [] };
}

async function main() {
  await connectDB();
  const cached = new Set();

  // 1. The demo user (badges/bio/avatar are cosmetic profile dressing).
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.findOneAndUpdate(
    { username: USERNAME },
    {
      $set: {
        username: USERNAME,
        email: EMAIL,
        passwordHash,
        name: "Yuviverse",
        bio: BIO,
        avatarUrl: AVATAR,
        badges: BADGES,
        dateOfBirth: new Date("1985-12-03"),
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
  console.log(`✔ user ${USERNAME} (${user._id})`);

  // 2. Rebuild every collection from its curated movie list.
  await Collection.deleteMany({ userId: user._id });
  const base = Date.now();
  for (const col of COLLECTIONS) {
    const items = [];
    const seen = new Set();
    for (const mv of col.movies) {
      const r = await resolve(mv.t, mv.y, cached);
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      const i = items.length;
      items.push({
        movieId: r.id,
        genre_ids: r.genre_ids, // makes the collection-grid genre filter work
        sortOrder: i, // earlier-in-list → shown first (drives the cover order)
        addedAt: new Date(base - i * 3600_000), // staggered hourly, for a realistic feed
      });
    }
    await Collection.create({
      userId: user._id,
      name: col.name,
      isPublic: col.isPublic,
      isDefault: col.isDefault,
      items,
    });
    const want = col.movies.length;
    const note = items.length < want ? ` (⚠ ${want - items.length} unresolved/dupes dropped)` : "";
    console.log(
      `  • ${col.name}: ${items.length} movies, ${col.isPublic ? "public" : "private"}${note}`
    );
  }

  console.log(`\n✔ cached ${cached.size} unique movies`);
  console.log("\n=== DEMO USER READY ===");
  console.log(`  username: ${USERNAME}`);
  console.log(`  password: ${PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
