// funnel async handler rejections to the central error handler
const route = (fn) => (req, res, next) => fn(req, res).catch(next);

module.exports = route;
