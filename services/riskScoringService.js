const RiskScore = require("../models/RiskScore");
const Transaction = require("../models/Transaction");
const Loan = require("../models/Loan");
const Ride = require("../models/Ride");
const User = require("../models/User");
const Tier = require("../models/Tier");
const auditService = require("./auditService");
const mongoose = require("mongoose");

// ── Weight configuration (total = 100%) ────────────────────────────────────
const WEIGHTS = {
    transactionFrequency: 0.25,   // 25% — how actively they ride/transact
    repaymentHistory: 0.30,       // 30% — most important for lending
    activeDays: 0.15,             // 15% — platform engagement
    outstandingBalance: 0.15,     // 15% — current debt load
    priorLoanPerformance: 0.15,   // 15% — past loan success rate
};

// ── Tier-based max loan caps (RWF) ─────────────────────────────────────────
const TIER_LOAN_CAPS = {
    starter: 10000,
    bronze: 20000,
    silver: 35000,
    gold: 50000,
    platinum: 75000,
    gorilla: 100000,
};

/**
 * Calculate the risk score for a driver.
 * Uses ONLY relevant, permitted data: transaction frequency, repayment history,
 * active days, outstanding balance, and prior loan performance.
 */
const calculateRiskScore = async (driverId) => {
    const objectId = typeof driverId === "string"
        ? mongoose.Types.ObjectId.createFromHexString(driverId)
        : driverId;

    const user = await User.findById(driverId);
    if (!user) throw new Error("User not found");

    // ── Factor 1: Transaction Frequency (rides per month average) ────────
    const accountAgeDays = Math.max(1, Math.floor((Date.now() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24)));
    const accountAgeMonths = Math.max(1, accountAgeDays / 30);
    const totalRides = await Ride.countDocuments({ driverId: objectId, paymentStatus: "successful" });
    const avgRidesPerMonth = totalRides / accountAgeMonths;
    // Normalize: 30+ rides/month = 100 points
    const transactionFrequencyScore = Math.min(100, Math.round((avgRidesPerMonth / 30) * 100));

    // ── Factor 2: Repayment History ──────────────────────────────────────
    const allLoans = await Loan.find({ driverId: objectId });
    const closedLoans = allLoans.filter(l => l.loanStatus === "closed" || l.loanStatus === "successful");
    const defaultedLoans = allLoans.filter(l => l.loanStatus === "defaulted");
    const totalFinished = closedLoans.length + defaultedLoans.length;
    const repaymentHistoryScore = totalFinished > 0
        ? Math.round((closedLoans.length / totalFinished) * 100)
        : 50; // neutral if no history

    // ── Factor 3: Active Days on Platform ────────────────────────────────
    // Count distinct days with at least one successful transaction
    const activeDaysAgg = await Transaction.aggregate([
        { $match: { driverId: objectId, status: "successful" } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
        { $count: "days" },
    ]);
    const activeDays = activeDaysAgg[0]?.days || 0;
    // Normalize: 90+ active days = 100 points
    const activeDaysScore = Math.min(100, Math.round((activeDays / 90) * 100));

    // ── Factor 4: Outstanding Balance (inverse — less debt = better) ─────
    const activeLoans = allLoans.filter(l => ["active", "overdue", "disbursed"].includes(l.loanStatus));
    const totalOutstanding = activeLoans.reduce((sum, l) => sum + l.remainingBalance, 0);
    // Normalize: 0 outstanding = 100 points, 50000+ = 0 points
    const outstandingScore = Math.max(0, Math.round(100 - (totalOutstanding / 50000) * 100));

    // ── Factor 5: Prior Loan Performance ─────────────────────────────────
    // Based on how much of loan amount was repaid on time vs late
    let loanPerfScore = 50; // neutral default
    if (closedLoans.length > 0) {
        // Check if any loans were ever overdue before closing
        const overdueHistory = allLoans.filter(l => l.loanStatus === "overdue" || l.loanStatus === "defaulted");
        loanPerfScore = overdueHistory.length === 0 ? 100 : Math.max(0, 100 - (overdueHistory.length * 25));
    }

    // ── Calculate weighted score (0-1000) ────────────────────────────────
    const rawScore = (
        transactionFrequencyScore * WEIGHTS.transactionFrequency +
        repaymentHistoryScore * WEIGHTS.repaymentHistory +
        activeDaysScore * WEIGHTS.activeDays +
        outstandingScore * WEIGHTS.outstandingBalance +
        loanPerfScore * WEIGHTS.priorLoanPerformance
    );
    const score = Math.round(rawScore * 10); // scale 0-100 → 0-1000

    // ── Determine grade ──────────────────────────────────────────────────
    let grade;
    if (score >= 800) grade = "A";
    else if (score >= 600) grade = "B";
    else if (score >= 400) grade = "C";
    else if (score >= 200) grade = "D";
    else grade = "F";

    // ── Determine max loan eligible ──────────────────────────────────────
    const tier = await Tier.findOne({ driverId: objectId });
    const tierName = tier?.tier || "starter";
    const tierCap = TIER_LOAN_CAPS[tierName] || 10000;
    // Grade multiplier: A=100%, B=80%, C=60%, D=30%, F=0%
    const gradeMultipliers = { A: 1.0, B: 0.8, C: 0.6, D: 0.3, F: 0 };
    const maxLoanEligible = Math.round(tierCap * (gradeMultipliers[grade] || 0));

    // ── Upsert the score ─────────────────────────────────────────────────
    const riskScore = await RiskScore.findOneAndUpdate(
        { driverId: objectId },
        {
            score,
            grade,
            factors: {
                transactionFrequency: Math.round(avgRidesPerMonth * 10) / 10,
                repaymentHistory: repaymentHistoryScore,
                activeDaysOnPlatform: activeDays,
                outstandingBalance: totalOutstanding,
                priorLoanPerformance: loanPerfScore,
            },
            maxLoanEligible,
            lastCalculatedAt: new Date(),
        },
        { upsert: true, new: true }
    );

    await auditService.log({
        actorId: driverId,
        actorRole: "system",
        action: "risk_score_calculated",
        targetType: "RiskScore",
        targetId: riskScore._id,
        metadata: { score, grade, maxLoanEligible },
    });

    return riskScore;
};

/**
 * Get a driver's risk score (calculate if stale or missing)
 */
const getRiskScore = async (driverId) => {
    let rs = await RiskScore.findOne({ driverId });

    // Recalculate if missing or older than 24 hours
    const staleThreshold = 24 * 60 * 60 * 1000;
    if (!rs || (Date.now() - new Date(rs.lastCalculatedAt).getTime()) > staleThreshold) {
        rs = await calculateRiskScore(driverId);
    }

    return rs;
};

/**
 * Admin: get all risk scores (paginated)
 */
const getAllRiskScores = async (page = 1, limit = 20, gradeFilter = null) => {
    const filter = gradeFilter ? { grade: gradeFilter } : {};
    const skip = (page - 1) * limit;

    const [scores, total] = await Promise.all([
        RiskScore.find(filter)
            .populate("driverId", "firstName lastName phone email")
            .sort({ score: -1 })
            .skip(skip)
            .limit(limit),
        RiskScore.countDocuments(filter),
    ]);

    return { scores, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

module.exports = {
    calculateRiskScore,
    getRiskScore,
    getAllRiskScores,
    TIER_LOAN_CAPS,
};
