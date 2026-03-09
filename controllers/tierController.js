const Tier = require("../models/Tier");
const { getTierInfo, TIER_THRESHOLDS } = require("../services/tierService");

/**
 * Get tier info for authenticated driver
 * GET /api/driver/tier
 */
const getMyTier = async (req, res) => {
    try {
        const driverId = req.user.id;
        const tierInfo = await getTierInfo(driverId);

        res.status(200).json({
            tier: tierInfo.tier,
            totalRides: tierInfo.totalRides,
            monthlyRides: tierInfo.monthlyRides,
            multiplier: tierInfo.multiplier,
            thresholds: TIER_THRESHOLDS,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get tier leaderboard (top drivers)
 * GET /api/driver/leaderboard
 */
const getLeaderboard = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        const leaderboard = await Tier.find()
            .sort({ monthlyRides: -1 })
            .limit(limit)
            .populate("driverId", "firstName lastName phone");

        res.status(200).json(leaderboard);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getMyTier,
    getLeaderboard,
};
