const Tier = require("../models/Tier");
const Ride = require("../models/Ride");
const { sendSMS } = require("./smsService");
const User = require("../models/User");

// Tier thresholds (monthly rides)
const TIER_THRESHOLDS = {
    bronze: 0,
    silver: 400,
    gold: 600,
    platinum: 800,
};

const TIER_MULTIPLIERS = {
    bronze: 1.0,
    silver: 1.2,
    gold: 1.5,
    platinum: 2.0,
};

/**
 * Determine tier based on monthly ride count
 * @param {number} monthlyRides - Number of rides this month
 * @returns {string} Tier name
 */
function determineTier(monthlyRides) {
    if (monthlyRides >= 1000) return "platinum";
    if (monthlyRides >= 800) return "platinum";
    if (monthlyRides >= 600) return "gold";
    if (monthlyRides >= 400) return "silver";
    return "bronze";
}

/**
 * Update tier for a driver after a ride is logged
 * @param {string} driverId - Driver's user ID
 */
const updateTier = async (driverId) => {
    try {
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();

        // Count rides this month
        const startOfMonth = new Date(currentYear, currentMonth - 1, 1);
        const endOfMonth = new Date(currentYear, currentMonth, 0, 23, 59, 59, 999);

        const monthlyRideCount = await Ride.countDocuments({
            driverId,
            paymentStatus: "completed",
            createdAt: { $gte: startOfMonth, $lte: endOfMonth },
        });

        // Get total rides all time
        const totalRideCount = await Ride.countDocuments({ driverId, paymentStatus: "completed" });

        const newTier = determineTier(monthlyRideCount);
        const multiplier = TIER_MULTIPLIERS[newTier];

        // Find or create tier record
        let tierRecord = await Tier.findOne({ driverId });

        if (!tierRecord) {
            tierRecord = await Tier.create({
                driverId,
                totalRides: totalRideCount,
                monthlyRides: monthlyRideCount,
                tier: newTier,
                multiplier,
                month: currentMonth,
                year: currentYear,
            });
        } else {
            const previousTier = tierRecord.tier;

            tierRecord.totalRides = totalRideCount;
            tierRecord.monthlyRides = monthlyRideCount;
            tierRecord.tier = newTier;
            tierRecord.multiplier = multiplier;
            tierRecord.month = currentMonth;
            tierRecord.year = currentYear;
            await tierRecord.save();

            // Send SMS on tier promotion
            if (previousTier !== newTier) {
                const tierOrder = ["bronze", "silver", "gold", "platinum"];
                if (tierOrder.indexOf(newTier) > tierOrder.indexOf(previousTier)) {
                    const user = await User.findById(driverId);
                    if (user) {
                        await sendSMS(
                            user.phone,
                            `Congratulations ${user.firstName}! You've been promoted to ${newTier.toUpperCase()} tier with a ${multiplier}x reward multiplier! Keep riding with MOTA!`,
                            "tier_promotion"
                        );
                    }
                }
            }
        }

        return tierRecord;
    } catch (error) {
        console.error("Error updating tier:", error.message);
        throw error;
    }
};

/**
 * Get tier info for a driver
 * @param {string} driverId - Driver's user ID
 * @returns {Object} Tier information
 */
const getTierInfo = async (driverId) => {
    let tierRecord = await Tier.findOne({ driverId });

    if (!tierRecord) {
        tierRecord = await Tier.create({
            driverId,
            totalRides: 0,
            monthlyRides: 0,
            tier: "bronze",
            multiplier: 1.0,
            month: new Date().getMonth() + 1,
            year: new Date().getFullYear(),
        });
    }

    return tierRecord;
};

module.exports = {
    updateTier,
    getTierInfo,
    determineTier,
    TIER_THRESHOLDS,
    TIER_MULTIPLIERS,
};
