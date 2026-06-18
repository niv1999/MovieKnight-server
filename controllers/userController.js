// controllers/userController.js — current-user profile updates.
// PATCH /api/users/me lets the signed-in user edit their own editable fields
// (bio for now; name/avatarUrl/countryCode too). Never touches email/username/
// passwordHash — those need dedicated flows. Returns the updated safe user.

const User = require("../models/User");
const { publicUser } = require("./authController");

const BIO_MAX = 280;

// PATCH /api/users/me — requireAuth has already set req.user.
async function updateMe(req, res, next) {
  try {
    const body = req.body || {};
    const updates = {};

    if (body.bio !== undefined) {
      if (typeof body.bio !== "string") {
        return res.status(400).json({ ok: false, error: "bio must be a string" });
      }
      const bio = body.bio.trim();
      if (bio.length > BIO_MAX) {
        return res
          .status(400)
          .json({ ok: false, error: `bio must be ${BIO_MAX} characters or fewer` });
      }
      updates.bio = bio;
    }
    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.avatarUrl !== undefined) {
      const avatar = String(body.avatarUrl).trim();
      // Accept an empty string (clears it), an image data URL, or an http(s) URL.
      if (
        avatar &&
        !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(avatar) &&
        !/^https?:\/\//i.test(avatar)
      ) {
        return res
          .status(400)
          .json({ ok: false, error: "avatarUrl must be an image data URL or http(s) URL" });
      }
      if (avatar.length > 1_500_000) {
        return res
          .status(400)
          .json({ ok: false, error: "Avatar image is too large — please use a smaller picture" });
      }
      updates.avatarUrl = avatar;
    }
    if (body.countryCode !== undefined) {
      updates.countryCode = String(body.countryCode).trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: "No updatable fields provided" });
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    }).select("-passwordHash");
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    return res.json({ ok: true, data: { user: publicUser(user) } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { updateMe };
