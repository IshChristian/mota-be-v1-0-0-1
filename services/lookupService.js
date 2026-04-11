const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const Ride = require("../models/Ride");
const Fine = require("../models/Fine");
const FineRequest = require("../models/FineRequest");
const Loan = require("../models/Loan");
const Referral = require("../models/Referral");
const Tier = require("../models/Tier");
const Streak = require("../models/Streak");
const Transfer = require("../models/Transfer");
const Notification = require("../models/Notification");
const RiderAlgorithm = require("../models/RiderAlgorithm");

/**
 * Fetch ALL related data for a single user by plate number
 * Aggregates: user info, profile, loan, fine, referral, rides, tiers, wallet, transactions, algorithm data
 */
const getFullUserDataByPlateNumber = async (plateNumber, options = {}) => {
    const { transactionLimit = 50, rideLimit = 50 } = options;

    // 1. Find driver profile by plate number (case-insensitive)
    const profile = await DriverProfile.findOne({
        plateNumber: { $regex: new RegExp(`^${escapeRegex(plateNumber)}$`, "i") },
    });

    if (!profile) {
        return null;
    }

    const driverId = profile.driverId;

    // 2. Fetch all related data in parallel
    const [
        user,
        wallet,
        tierRecord,
        streakRecord,
        algorithmRecord,
        rides,
        rideCount,
        fines,
        fineRequests,
        loans,
        referralsMade,
        referralsReceived,
        transactions,
        transactionCount,
        transfers,
        notifications,
    ] = await Promise.all([
        // User info
        User.findById(driverId).select("-password -otpToken -twoFactorSecret"),

        // Wallet
        Wallet.findOne({ driverId }),

        // Tier
        Tier.findOne({ driverId }),

        // Streak
        Streak.findOne({ driverId }),

        // Algorithm Engine data
        RiderAlgorithm.findOne({ riderId: driverId }),

        // Rides (recent)
        Ride.find({ driverId })
            .sort({ createdAt: -1 })
            .limit(rideLimit),

        // Total ride count
        Ride.countDocuments({ driverId }),

        // Fines
        Fine.find({ driverId })
            .populate("reviewedBy", "firstName lastName")
            .sort({ createdAt: -1 }),

        // Fine Requests
        FineRequest.find({ driverId })
            .populate("reviewedBy", "firstName lastName")
            .sort({ createdAt: -1 }),

        // Loans
        Loan.find({ driverId })
            .populate("approvedBy", "firstName lastName")
            .sort({ createdAt: -1 }),

        // Referrals made by this driver
        Referral.find({ referrerId: driverId })
            .populate("referredUserId", "firstName lastName phone")
            .sort({ createdAt: -1 }),

        // Referrals received (someone referred this driver)
        Referral.find({ referredUserId: driverId })
            .populate("referrerId", "firstName lastName phone"),

        // Transactions (recent)
        Transaction.find({ driverId })
            .sort({ createdAt: -1 })
            .limit(transactionLimit),

        // Total transaction count
        Transaction.countDocuments({ driverId }),

        // P2P Transfers
        Transfer.find({
            $or: [{ senderId: driverId }, { receiverId: driverId }],
        })
            .sort({ createdAt: -1 })
            .limit(20)
            .populate("senderId", "firstName lastName phone")
            .populate("receiverId", "firstName lastName phone"),

        // Notifications
        Notification.find({ userId: driverId })
            .sort({ createdAt: -1 })
            .limit(20),
    ]);

    if (!user) return null;

    // Compute summary stats
    const rideStats = await computeRideStats(driverId);
    const financialSummary = await computeFinancialSummary(driverId, transactions);

    return {
        // User & Profile
        user,
        profile,

        // Wallet
        wallet: wallet || { balance: 0, fuelCredits: 0 },

        // Tier & Streak
        tier: tierRecord || { tier: "starter", totalRides: 0, monthlyRides: 0, multiplier: 1.0 },
        streak: streakRecord || { currentStreak: 0, longestStreak: 0, todayRideCount: 0 },

        // Algorithm Engine data
        algorithm: algorithmRecord || null,

        // Rides
        rides: {
            recent: rides,
            totalCount: rideCount,
            stats: rideStats,
        },

        // Fines & Fine Requests
        fines,
        fineRequests,

        // Loans
        loans,

        // Referrals
        referrals: {
            made: referralsMade,
            received: referralsReceived,
            totalMade: referralsMade.length,
            totalCompleted: referralsMade.filter(r => r.status === "completed").length,
        },

        // Transactions
        transactions: {
            recent: transactions,
            totalCount: transactionCount,
        },

        // P2P Transfers
        transfers,

        // Notifications
        notifications,

        // Summary
        financialSummary,
    };
};

/**
 * Fetch ALL related data for a single user by user ID
 */
const getFullUserDataById = async (userId, options = {}) => {
    const profile = await DriverProfile.findOne({ driverId: userId });

    if (profile) {
        return await getFullUserDataByPlateNumber(profile.plateNumber, options);
    }

    // User without a driver profile — return what we can
    const { transactionLimit = 50 } = options;

    const [user, wallet, transactions, transactionCount, notifications] = await Promise.all([
        User.findById(userId).select("-password -otpToken -twoFactorSecret"),
        Wallet.findOne({ driverId: userId }),
        Transaction.find({ driverId: userId }).sort({ createdAt: -1 }).limit(transactionLimit),
        Transaction.countDocuments({ driverId: userId }),
        Notification.find({ userId }).sort({ createdAt: -1 }).limit(20),
    ]);

    if (!user) return null;

    return {
        user,
        profile: null,
        wallet: wallet || { balance: 0, fuelCredits: 0 },
        tier: null,
        streak: null,
        algorithm: null,
        rides: { recent: [], totalCount: 0, stats: {} },
        fines: [],
        fineRequests: [],
        loans: [],
        referrals: { made: [], received: [], totalMade: 0, totalCompleted: 0 },
        transactions: { recent: transactions, totalCount: transactionCount },
        transfers: [],
        notifications,
        financialSummary: { totalEarnings: 0, totalSpent: 0, totalFines: 0 },
    };
};

/**
 * Compute ride statistics
 */
const computeRideStats = async (driverId) => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const [ridesToday, ridesThisWeek, ridesThisMonth, totalFare, completedRides] = await Promise.all([
        Ride.countDocuments({ driverId, createdAt: { $gte: startOfToday } }),
        Ride.countDocuments({ driverId, createdAt: { $gte: startOfWeek } }),
        Ride.countDocuments({ driverId, createdAt: { $gte: startOfMonth } }),
        Ride.aggregate([
            { $match: { driverId: (typeof driverId === "string" ? require("mongoose").Types.ObjectId.createFromHexString(driverId) : driverId), paymentStatus: "completed" } },
            { $group: { _id: null, totalFare: { $sum: "$fare" }, totalDriverEarning: { $sum: "$driverEarning" } } },
        ]),
        Ride.countDocuments({ driverId, paymentStatus: "completed" }),
    ]);

    return {
        ridesToday,
        ridesThisWeek,
        ridesThisMonth,
        totalCompletedRides: completedRides,
        totalFareCollected: totalFare[0]?.totalFare || 0,
        totalDriverEarnings: totalFare[0]?.totalDriverEarning || 0,
    };
};

/**
 * Compute financial summary from transactions
 */
const computeFinancialSummary = async (driverId, transactions) => {
    const earnings = transactions
        .filter(t => t.amount > 0 && ["ride_payment", "cash_in", "agent_cash_in", "referral_reward", "admin_credit"].includes(t.type))
        .reduce((sum, t) => sum + t.amount, 0);

    const spent = transactions
        .filter(t => t.amount < 0)
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const finesPaid = transactions
        .filter(t => t.type === "fine_payment")
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const commissionPaid = transactions
        .filter(t => t.type === "platform_commission")
        .reduce((sum, t) => sum + t.amount, 0);

    return {
        totalEarnings: earnings,
        totalSpent: spent,
        totalFinesPaid: finesPaid,
        totalCommissionPaid: commissionPaid,
    };
};

/**
 * Escape regex special characters
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
    getFullUserDataByPlateNumber,
    getFullUserDataById,
    computeRideStats,
    computeFinancialSummary,
};
