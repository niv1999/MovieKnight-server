// utils/route.js — wrap an async (req, res) handler so a rejected promise is
// forwarded to Express's central error handler instead of crashing the request.
// Keeps each route registration a one-liner: router.get(path, route(handler)).
const route = (fn) => (req, res, next) => fn(req, res).catch(next);

module.exports = route;
