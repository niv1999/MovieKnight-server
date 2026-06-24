// services/aiQuota.js — per-user daily quota for the Gemini-backed AI features
// ("Let AI Choose", "AI Search", and later "Enhance Collection"). Each of those
// requests spends ONE action; a user gets DAILY_AI_LIMIT per calendar day.
//
// Reset is LAZY (no cron, no TTL): the count is stamped with the Pacific calendar
// day it belongs to. When we read/consume on a NEW Pacific day the old count is
// simply ignored (treated as 0) and overwritten — so the quota "resets" at
// midnight America/Los_Angeles automatically, DST included (Intl handles the
// PST/PDT shift). This suits our stack: Render's free tier can sleep, which would
// make a nightly cron unreliable anyway.

const User = require("../models/User");

const DAILY_AI_LIMIT = 5;

// Error `code` for "out of daily AI actions". Both the quota limit and an upstream
// Gemini rate-limit surface as HTTP 429, so the client can't tell them apart by
// status alone — this code (carried through the error envelope) disambiguates, so
// the UI shows "you're out of daily actions" rather than the generic "AI is busy".
const AI_LIMIT_CODE = "AI_LIMIT_REACHED";

// Build the 429 thrown when a user has no actions left today.
function aiLimitError() {
  const err = new Error(
    "You've used all your daily AI actions. They reset at midnight Pacific time."
  );
  err.status = 429;
  err.code = AI_LIMIT_CODE;
  return err;
}

// Today's date in the Pacific zone as "YYYY-MM-DD" (en-CA formats that way).
// This is the bucket key the per-user count is stamped against.
function pacificDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(d);
}

// Current usage for a user, applying the lazy reset: a count stamped with an
// earlier Pacific day counts as 0 today. Pure read — never writes.
function aiUsageFor(user) {
  const today = pacificDay();
  const u = (user && user.aiUsage) || {};
  const used = u.day === today ? u.count || 0 : 0;
  return { used, remaining: Math.max(0, DAILY_AI_LIMIT - used), limit: DAILY_AI_LIMIT };
}

// Spend one action for `user`, after applying the lazy reset. Throws a 429 (with a
// user-safe message — no provider named) when the daily limit is already reached.
// Persists the new count and mutates the in-memory `user.aiUsage` so the caller's
// req.user stays accurate for the rest of the request. Returns the fresh usage.
async function consumeAiAction(user) {
  const today = pacificDay();
  const u = user.aiUsage || {};
  const used = u.day === today ? u.count || 0 : 0;

  if (used >= DAILY_AI_LIMIT) throw aiLimitError();

  const count = used + 1;
  await User.updateOne(
    { _id: user._id },
    { $set: { "aiUsage.count": count, "aiUsage.day": today } }
  );
  user.aiUsage = { count, day: today };
  return { used: count, remaining: DAILY_AI_LIMIT - count, limit: DAILY_AI_LIMIT };
}

module.exports = {
  DAILY_AI_LIMIT,
  AI_LIMIT_CODE,
  aiLimitError,
  pacificDay,
  aiUsageFor,
  consumeAiAction,
};
