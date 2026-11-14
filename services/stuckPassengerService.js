const User = require("../models/User");
const AuditLog = require("../models/AuditLog");

// SMS has failed since this date, so passengers who registered after it could never
// enter their phone code and were left inactive.
const SMS_OUTAGE_START = new Date("2026-03-18T00:00:00Z");

/** Unverified, inactive passengers from the SMS outage, excluding anyone an admin switched off. */
const findStuckPassengers = async () => {
    const candidates = await User.find({
        role: "client", isVerified: false, isActive: false, deletedAt: null,
        activationBlocked: { $ne: true }, createdAt: { $gte: SMS_OUTAGE_START },
    }).select("_id");
    if (!candidates.length) return [];
    const ids = candidates.map((user) => user._id);
    const disabledByStaff = await AuditLog.distinct("targetId", {
        action: "user_updated", targetId: { $in: ids }, "metadata.changes.isActive": { $exists: true },
    });
    const skip = new Set(disabledByStaff.map(String));
    return candidates.filter((user) => !skip.has(String(user._id)));
};

/** Let stuck passengers in. Their phone is proven later by their first MoMo payment. */
const activateStuckPassengers = async ({ dryRun = true } = {}) => {
    const stuck = await findStuckPassengers();
    if (dryRun || !stuck.length) return { matched: stuck.length, activated: 0 };
    const result = await User.updateMany(
        { _id: { $in: stuck.map((user) => user._id) }, isActive: false, isVerified: false },
        { $set: { isActive: true } },
    );
    return { matched: stuck.length, activated: result.modifiedCount };
};

module.exports = { SMS_OUTAGE_START, findStuckPassengers, activateStuckPassengers };
