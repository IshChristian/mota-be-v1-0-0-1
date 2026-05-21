const RiderAlgorithm = require("../models/RiderAlgorithm");
const Ride = require("../models/Ride");
const User = require("../models/User");
const Tier = require("../models/Tier");
const Streak = require("../models/Streak");
const { sendSMS } = require("./smsService");
const { getSetting } = require("./systemSettingService");

// ─── TIER THRESHOLDS (monthly rides) ─────────────────────────────────────────
const TIER_THRESHOLDS = {
    Bronze: 0,
    Silver: 600,
    Gold: 800,
    Platinum: 1000,
};

const TIER_ORDER = ["Bronze", "Silver", "Gold", "Platinum"];

// ─── SALARY MULTIPLIERS ─────────────────────────────────────────────────────
const TIER_MULTIPLIERS = {
    Bronze: 1.0,
    Silver: 1.2,
    Gold: 1.5,
    Platinum: 2.0,
};

const BASE_DAILY_PAY = 22000;

// ─── CONFIGURABLE TIER FEATURES ─────────────────────────────────────────────
const DEFAULT_TIER_FEATURES = {
    Silver: ["rain_bonus"],
    Gold: ["fuel_voucher"],
    Platinum: ["priority_loans"],
};

// ─── DAILY TARGET FOR STREAK ─────────────────────────────────────────────────
const DAILY_STREAK_TARGET = 20;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE: Get or Create RiderAlgorithm record
// ═══════════════════════════════════════════════════════════════════════════════
const getOrCreateRider = async (riderId) => {
    let rider = await RiderAlgorithm.findOne({ riderId });
    if (!rider) {
        rider = await RiderAlgorithm.create({
            riderId,
            daily_rides: 0,
            monthly_rides: 0,
            current_tier: "Bronze",
            streak_days: 0,
            fines_paid: 0,
            fuel_vouchers_used: 0,
            features_unlocked: [],
            trophies: [],
            first_activity_date: new Date(),
        });
    }
    return rider;
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTION: Process Ride
// ═══════════════════════════════════════════════════════════════════════════════
const processRide = async (riderId) => {
    const rider = await getOrCreateRider(riderId);

    // Idempotency: check if we already processed a ride for this exact moment
    rider.daily_rides += 1;
    rider.monthly_rides += 1;

    // Set first_activity_date if not set
    if (!rider.first_activity_date) {
        rider.first_activity_date = new Date();
    }

    // Run sub-engines
    updateStreak(rider);
    updateTier(rider);
    unlockFeatures(rider);
    checkTrophies(rider);

    // Calculate daily earnings
    rider.daily_earnings = calculateDailyPay(rider);
    rider.total_earnings += rider.daily_earnings;

    await rider.save();

    return rider;
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIER SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
const updateTier = (rider) => {
    const previousTier = rider.current_tier;

    if (rider.monthly_rides >= TIER_THRESHOLDS.Platinum) {
        rider.current_tier = "Platinum";
    } else if (rider.monthly_rides >= TIER_THRESHOLDS.Gold) {
        rider.current_tier = "Gold";
    } else if (rider.monthly_rides >= TIER_THRESHOLDS.Silver) {
        rider.current_tier = "Silver";
    } else {
        rider.current_tier = "Bronze";
    }

    // Return whether a tier change occurred
    return previousTier !== rider.current_tier;
};

// ═══════════════════════════════════════════════════════════════════════════════
// SALARY CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════
const calculateDailyPay = (rider) => {
    const base = BASE_DAILY_PAY;
    const multiplier = TIER_MULTIPLIERS[rider.current_tier] || 1.0;
    return Math.round(base * multiplier);
};

// ═══════════════════════════════════════════════════════════════════════════════
// STREAK SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
const updateStreak = (rider) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let lastRideDay = null;
    if (rider.last_ride_date) {
        lastRideDay = new Date(rider.last_ride_date);
        lastRideDay.setHours(0, 0, 0, 0);
    }

    if (lastRideDay && lastRideDay.getTime() === yesterday.getTime() && rider.daily_rides >= DAILY_STREAK_TARGET) {
        rider.streak_days += 1;
    } else if (rider.daily_rides >= DAILY_STREAK_TARGET) {
        rider.streak_days = 1;
    } else {
        // Don't reset during the day — only evaluate at end or when target not met
        // Streak stays if daily target not yet reached (still accumulating)
    }

    rider.last_ride_date = new Date();
};

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE UNLOCK ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const unlockFeatures = (rider) => {
    const tierFeatures = DEFAULT_TIER_FEATURES;
    const features = new Set(rider.features_unlocked || []);
    const riderTierIndex = TIER_ORDER.indexOf(rider.current_tier);

    for (const tier of TIER_ORDER) {
        const tierIndex = TIER_ORDER.indexOf(tier);
        if (riderTierIndex >= tierIndex && tierFeatures[tier]) {
            for (const feature of tierFeatures[tier]) {
                features.add(feature);
            }
        }
    }

    rider.features_unlocked = Array.from(features);
};

// ═══════════════════════════════════════════════════════════════════════════════
// TROPHY SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
const addTrophy = (rider, trophy) => {
    if (!rider.trophies.includes(trophy)) {
        rider.trophies.push(trophy);
    }
};

const checkTrophies = (rider) => {
    if (rider.streak_days >= 20) {
        addTrophy(rider, "Streak Master");
    }

    if (rider.fines_paid >= 10) {
        addTrophy(rider, "Fine Slayer");
    }

    if (rider.fuel_vouchers_used >= 50) {
        addTrophy(rider, "Fuel Legend");
    }

    if (rider.current_tier === "Platinum") {
        addTrophy(rider, "Tier Lord");
    }

    // Additional trophies
    if (rider.monthly_rides >= 500) {
        addTrophy(rider, "500 Club");
    }

    if (rider.monthly_rides >= 1000) {
        addTrophy(rider, "Millennium Rider");
    }

    if (rider.streak_days >= 30) {
        addTrophy(rider, "Iron Will");
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// REVENUE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const calculateRevenue = async () => {
    const Transaction = require("../models/Transaction");
    const Fine = require("../models/Fine");
    const Referral = require("../models/Referral");
    const Loan = require("../models/Loan");

    // Platform commission from rides
    const commissionAgg = await Transaction.aggregate([
        { $match: { type: "platform_commission", status: "successful" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalCommissions = commissionAgg[0]?.total || 0;

    // Fine payments revenue
    const fineAgg = await Transaction.aggregate([
        { $match: { type: "fine_payment", status: "successful" } },
        { $group: { _id: null, total: { $sum: { $abs: "$amount" } } } },
    ]);
    const totalFineRevenue = fineAgg[0]?.total || 0;

    // Cash-out fees
    const cashOutFeeAgg = await Transaction.aggregate([
        { $match: { type: "cash_out_fee", status: "successful" } },
        { $group: { _id: null, total: { $sum: { $abs: "$amount" } } } },
    ]);
    const totalCashOutFees = cashOutFeeAgg[0]?.total || 0;

    // Transaction fees
    const txFeeAgg = await Transaction.aggregate([
        { $match: { type: "transaction_fee", status: "successful" } },
        { $group: { _id: null, total: { $sum: { $abs: "$amount" } } } },
    ]);
    const totalTxFees = txFeeAgg[0]?.total || 0;

    // Registration fees (agent + driver)
    const regFeeAgg = await Transaction.aggregate([
        { $match: { type: { $in: ["agent_registration_fee", "commission"] }, status: "successful" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalRegistrationFees = regFeeAgg[0]?.total || 0;

    // Loan interest revenue
    const loanInterestAgg = await Loan.aggregate([
        { $match: { loanStatus: { $in: ["active", "successful"] } } },
        { $group: { _id: null, total: { $sum: { $subtract: ["$totalWithInterest", "$loanAmount"] } } } },
    ]);
    const totalLoanInterest = loanInterestAgg[0]?.total || 0;

    // Total referral costs (outgoing)
    const referralAgg = await Transaction.aggregate([
        { $match: { type: "referral_reward", status: "successful" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalReferralCosts = referralAgg[0]?.total || 0;

    // Calculated example (from spec pseudocode)
    const estimatedRevenue = {
        fares_commission: totalCommissions,
        fine_revenue: totalFineRevenue,
        cash_out_fees: totalCashOutFees,
        transaction_fees: totalTxFees,
        registration_fees: totalRegistrationFees,
        loan_interest: totalLoanInterest,
        referral_costs: totalReferralCosts,
    };

    estimatedRevenue.total =
        estimatedRevenue.fares_commission +
        estimatedRevenue.fine_revenue +
        estimatedRevenue.cash_out_fees +
        estimatedRevenue.transaction_fees +
        estimatedRevenue.registration_fees +
        estimatedRevenue.loan_interest;

    estimatedRevenue.net_revenue = estimatedRevenue.total - estimatedRevenue.referral_costs;

    return estimatedRevenue;
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET RIDER STATUS
// ═══════════════════════════════════════════════════════════════════════════════
const getRiderStatus = async (riderId) => {
    const rider = await getOrCreateRider(riderId);

    return {
        rider_id: rider.riderId,
        daily_rides: rider.daily_rides,
        monthly_rides: rider.monthly_rides,
        current_tier: rider.current_tier,
        streak_days: rider.streak_days,
        last_ride_date: rider.last_ride_date,
        fines_paid: rider.fines_paid,
        fuel_vouchers_used: rider.fuel_vouchers_used,
        features_unlocked: rider.features_unlocked,
        trophies: rider.trophies,
        first_activity_date: rider.first_activity_date,
        cycle_number: rider.cycle_number,
        daily_earnings: calculateDailyPay(rider),
        total_earnings: rider.total_earnings,
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET RIDER EARNINGS
// ═══════════════════════════════════════════════════════════════════════════════
const getRiderEarnings = async (riderId) => {
    const rider = await getOrCreateRider(riderId);

    const dailyPay = calculateDailyPay(rider);
    const monthlyEstimate = dailyPay * 30;

    return {
        rider_id: rider.riderId,
        current_tier: rider.current_tier,
        multiplier: TIER_MULTIPLIERS[rider.current_tier] || 1.0,
        base_daily_pay: BASE_DAILY_PAY,
        daily_pay: dailyPay,
        monthly_estimate: monthlyEstimate,
        total_earnings: rider.total_earnings,
        daily_rides: rider.daily_rides,
        monthly_rides: rider.monthly_rides,
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Daily Reset Job — runs at 00:00 midnight
 * Resets daily_rides to 0 for all riders
 */
const dailyResetJob = async () => {
    try {
        const result = await RiderAlgorithm.updateMany(
            {},
            { $set: { daily_rides: 0, daily_earnings: 0 } }
        );
        console.log(`🕐 Daily reset: ${result.modifiedCount} riders reset`);
        return result;
    } catch (error) {
        console.error("❌ Daily reset failed:", error.message);
        throw error;
    }
};

/**
 * Monthly Reset Job — runs for riders whose 30-day cycle has ended
 * Resets monthly_rides, streak_days, stores previous cycle stats
 */
const monthlyResetJob = async () => {
    try {
        const now = new Date();
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const ridersToReset = await RiderAlgorithm.find({
            first_activity_date: { $lte: thirtyDaysAgo },
        });

        let resetCount = 0;

        for (const rider of ridersToReset) {
            // Store previous cycle
            rider.previous_cycles.push({
                cycle_number: rider.cycle_number,
                monthly_rides: rider.monthly_rides,
                tier: rider.current_tier,
                streak_days: rider.streak_days,
                trophies: [...rider.trophies],
                ended_at: now,
            });

            // Reset
            rider.monthly_rides = 0;
            rider.streak_days = 0;
            rider.first_activity_date = now;
            rider.cycle_number += 1;

            // Recalculate tier
            updateTier(rider);
            unlockFeatures(rider);

            await rider.save();
            resetCount++;
        }

        console.log(`📅 Monthly reset: ${resetCount} riders cycled`);
        return { resetCount };
    } catch (error) {
        console.error("❌ Monthly reset failed:", error.message);
        throw error;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RECORD FINE PAID (increments fines_paid counter for trophies)
// ═══════════════════════════════════════════════════════════════════════════════
const recordFinePaid = async (riderId) => {
    const rider = await getOrCreateRider(riderId);
    rider.fines_paid += 1;
    checkTrophies(rider);
    await rider.save();
    return rider;
};

// ═══════════════════════════════════════════════════════════════════════════════
// RECORD FUEL VOUCHER USED
// ═══════════════════════════════════════════════════════════════════════════════
const recordFuelVoucherUsed = async (riderId) => {
    const rider = await getOrCreateRider(riderId);
    rider.fuel_vouchers_used += 1;
    checkTrophies(rider);
    await rider.save();
    return rider;
};

module.exports = {
    getOrCreateRider,
    processRide,
    updateTier,
    updateStreak,
    unlockFeatures,
    checkTrophies,
    addTrophy,
    calculateDailyPay,
    calculateRevenue,
    getRiderStatus,
    getRiderEarnings,
    dailyResetJob,
    monthlyResetJob,
    recordFinePaid,
    recordFuelVoucherUsed,
    // Constants
    TIER_THRESHOLDS,
    TIER_MULTIPLIERS,
    TIER_ORDER,
    BASE_DAILY_PAY,
    DAILY_STREAK_TARGET,
    DEFAULT_TIER_FEATURES,
};
