const Tier = require("../models/Tier");
const Ride = require("../models/Ride");
const User = require("../models/User");
const { sendSMS } = require("./smsService");
const { getSetting } = require("./systemSettingService");

const TIER_MULTIPLIERS = {
    starter: 1.0,
    bronze: 1.1,
    silver: 1.2,
    gold: 1.5,
    platinum: 2.0,
    gorilla: 3.0,
};

const getThresholds = async () => {
    return {
        starter: 0,
        bronze: await getSetting("tier_bronze_rides", 600),
        silver: await getSetting("tier_silver_rides", 1500),
        gold: await getSetting("tier_gold_rides", 5000),
        platinum: await getSetting("tier_platinum_rides", 100000),
        gorilla: await getSetting("tier_gorilla_rides", 1000000),
    };
};

/**
 * Determine tier based on total (lifetime) ride count
 * @param {number} totalRides - Total lifetime rides
 * @returns {string} Tier name
 */
const determineTier = async (totalRides) => {
    const thresholds = await getThresholds();
    if (totalRides >= thresholds.gorilla) return "gorilla";
    if (totalRides >= thresholds.platinum) return "platinum";
    if (totalRides >= thresholds.gold) return "gold";
    if (totalRides >= thresholds.silver) return "silver";
    if (totalRides >= thresholds.bronze) return "bronze";
    return "starter";
};

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

        const totalRideCount = await Ride.countDocuments({ driverId, paymentStatus: "completed" });

        const newTier = await determineTier(totalRideCount);
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
                const tierOrder = ["starter", "bronze", "silver", "gold", "platinum", "gorilla"];
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
            tier: "starter",
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
    getThresholds,
    TIER_MULTIPLIERS,
};
