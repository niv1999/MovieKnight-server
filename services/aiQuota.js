// Per-user daily AI quota. Reset is lazy: the count is stamped with the Pacific
// calendar day, so on a new Pacific day the old count is treated as 0 and
// overwritten. Avoids needing a cron on a free tier that can sleep.

const User = require("../models/User");

const DAILY_AI_LIMIT = Number(process.env.AI_DAILY_LIMIT) > 0
  ? Number(process.env.AI_DAILY_LIMIT)
  : 5;

// quota and an upstream rate-limit both surface as 429; this code lets the UI tell
// "out of daily actions" from "AI is busy"
const AI_LIMIT_CODE = "AI_LIMIT_REACHED";

function aiLimitError() {
  const err = new Error(
    "You've used all your daily AI actions. They reset at midnight Pacific time."
  );
  err.status = 429;
  err.code = AI_LIMIT_CODE;
  return err;
}

// today in Pacific as "YYYY-MM-DD" (en-CA formats that way)
function pacificDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(d);
}

// current usage with lazy reset applied; pure read
function aiUsageFor(user) {
  const today = pacificDay();
  const u = (user && user.aiUsage) || {};
  const used = u.day === today ? u.count || 0 : 0;
  return { used, remaining: Math.max(0, DAILY_AI_LIMIT - used), limit: DAILY_AI_LIMIT };
}

// spend one action after lazy reset; throws 429 at the limit. also mutates
// in-memory user.aiUsage so req.user stays accurate for the rest of the request.
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
  aiLimitError,
  aiUsageFor,
  consumeAiAction,
};
