const algorithmService = require("../services/algorithmService");

/**
 * POST /api/ride/complete
 * Process a completed ride through the MOTA Algorithm Engine
 */
const completeRide = async (req, res) => {
    try {
        const riderId = req.user.id;

        const riderData = await algorithmService.processRide(riderId);

        res.status(200).json({
            message: "Ride processed successfully",
            data: {
                daily_rides: riderData.daily_rides,
                monthly_rides: riderData.monthly_rides,
                current_tier: riderData.current_tier,
                streak_days: riderData.streak_days,
                features_unlocked: riderData.features_unlocked,
                trophies: riderData.trophies,
                daily_earnings: riderData.daily_earnings,
                cycle_number: riderData.cycle_number,
            },
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/rider/status
 * Get rider status from the algorithm engine
 */
const getRiderStatus = async (req, res) => {
    try {
        const riderId = req.params.id || req.user.id;

        const status = await algorithmService.getRiderStatus(riderId);

        res.status(200).json({
            message: "Rider status retrieved",
            data: status,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/rider/earnings
 * Get rider earnings calculation
 */
const getRiderEarnings = async (req, res) => {
    try {
        const riderId = req.params.id || req.user.id;

        const earnings = await algorithmService.getRiderEarnings(riderId);

        res.status(200).json({
            message: "Rider earnings calculated",
            data: earnings,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/platform/revenue
 * Get platform revenue overview (admin only)
 */
const getPlatformRevenue = async (req, res) => {
    try {
        const revenue = await algorithmService.calculateRevenue();

        res.status(200).json({
            message: "Platform revenue calculated",
            data: revenue,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/algorithm/daily-reset (admin/cron)
 * Manually trigger daily reset
 */
const triggerDailyReset = async (req, res) => {
    try {
        const result = await algorithmService.dailyResetJob();

        res.status(200).json({
            message: "Daily reset executed successfully",
            modifiedCount: result.modifiedCount,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/algorithm/monthly-reset (admin/cron)
 * Manually trigger monthly reset
 */
const triggerMonthlyReset = async (req, res) => {
    try {
        const result = await algorithmService.monthlyResetJob();

        res.status(200).json({
            message: "Monthly reset executed successfully",
            resetCount: result.resetCount,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    completeRide,
    getRiderStatus,
    getRiderEarnings,
    getPlatformRevenue,
    triggerDailyReset,
    triggerMonthlyReset,
};
