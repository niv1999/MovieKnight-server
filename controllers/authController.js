// controllers/authController.js
// STUB auth so the client can build against it (task S1).
// Real bcryptjs hashing + JWT + Mongo come in task S4.

function signup(req, res) {
  const { username = "newuser", email = null } = req.body || {};
  res.status(201).json({
    ok: true,
    data: { token: "stub-token", user: { id: "stub-id", username, email } },
  });
}

function login(req, res) {
  res.json({
    ok: true,
    data: {
      token: "stub-token",
      user: { id: "stub-id", username: "admin", email: "admin@example.com" },
    },
  });
}

function me(req, res) {
  res.json({ ok: true, data: { user: { id: "stub-id", username: "admin" } } });
}

module.exports = { signup, login, me };
