const bcrypt = require("bcrypt");
const User = require("../models/User");

// Resolve an ambiguous registration response without creating another account.
// Require the same credentials submitted during registration before returning an ID.
async function recoverRegistration(req, res) {
  const phone = String(req.body?.phone || "").trim();
  const password = req.body?.password;
  if (!phone || typeof password !== "string" || !password) {
    return res.status(400).json({ message: "Phone and password are required" });
  }
  try {
    const user = await User.findOne({ phone });
    const matches = user?.password && await bcrypt.compare(password, user.password);
    if (!matches) return res.status(401).json({ message: "Unable to verify registration" });
    return res.json({ userId: user._id, isVerified: Boolean(user.isVerified) });
  } catch (error) {
    return res.status(503).json({ message: "Registration status is temporarily unavailable" });
  }
}

module.exports = { recoverRegistration };
