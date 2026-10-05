const User = require("../models/User");
// A new completed login restores automatic availability; app restoration keeps
// the saved manual-offline preference until the driver explicitly goes online.
async function beginDriverSession(user) {
  if (user.role !== "driver") return;
  await User.findByIdAndUpdate(user._id || user.id, {
    $set: { availabilityManuallyOffline: false },
  });
  user.availabilityManuallyOffline = false;
}
async function revokeSessionAndAvailability(user) {
  const update = { $inc: { tokenVersion: 1 } };
  if (user.role === "driver")
    update.$set = { isOnline: false, availabilityManuallyOffline: true };
  await User.findByIdAndUpdate(user._id || user.id, update);
}
module.exports = { beginDriverSession, revokeSessionAndAvailability };
