const Loan = require("../models/Loan");
const User = require("../models/User");
const Tier = require("../models/Tier");
const Transaction = require("../models/Transaction");
const riskScoringService = require("./riskScoringService");
const auditService = require("./auditService");
const systemSettingService = require("./systemSettingService");

/**
 * Check if a driver is eligible for a fine loan.
 * Returns { eligible, maxAmount, reason, riskScore }
 */
const checkEligibility = async (driverId) => {
    const user = await User.findById(driverId);
    if (!user) return { eligible: false, reason: "User not found", maxAmount: 0 };

    // Rule 1: Must be an approved, active rider
    if (!user.isActive || user.registrationStatus !== "approved") {
        return { eligible: false, reason: "Account is not active or not approved.", maxAmount: 0 };
    }

    // Rule 2: Must be phone-verified
    if (!user.isVerified) {
        return { eligible: false, reason: "Phone number is not verified.", maxAmount: 0 };
    }

    // Rule 3: Must have KYC at least basic
    if (!user.kycLevel) {
        return { eligible: false, reason: "KYC verification is required.", maxAmount: 0 };
    }

    // Rule 4: Must have transaction history (at least 5 successful transactions)
    const txCount = await Transaction.countDocuments({ driverId, status: "successful" });
    const minTxRequired = await systemSettingService.getSetting("loan_min_transactions_required", 5);
    if (txCount < minTxRequired) {
        return { eligible: false, reason: `Minimum ${minTxRequired} successful transactions required. You have ${txCount}.`, maxAmount: 0 };
    }

    // Rule 5: Only one active loan at a time
    const activeLoan = await Loan.findOne({
        driverId,
        loanStatus: { $in: ["pending_review", "approved", "disbursed", "active"] },
    });
    if (activeLoan) {
        return { eligible: false, reason: "You already have an active or pending loan.", maxAmount: 0, activeLoanId: activeLoan._id };
    }

    // Rule 6: No overdue or defaulted loans (must clear arrears first)
    const overdueLoans = await Loan.findOne({
        driverId,
        loanStatus: { $in: ["overdue", "defaulted"] },
    });
    if (overdueLoans) {
        return { eligible: false, reason: "You have overdue or defaulted loans. Please clear them first.", maxAmount: 0 };
    }

    // Rule 7: Calculate risk score and derive max loan amount
    const riskScore = await riskScoringService.getRiskScore(driverId);

    if (riskScore.grade === "F") {
        return { eligible: false, reason: "Risk score too low for lending.", maxAmount: 0, riskScore };
    }

    return {
        eligible: true,
        reason: "Eligible for a fine loan.",
        maxAmount: riskScore.maxLoanEligible,
        riskScore: {
            score: riskScore.score,
            grade: riskScore.grade,
            factors: riskScore.factors,
        },
    };
};

/**
 * Determine repayment frequency based on rider's cash flow pattern
 */
const determineRepaymentFrequency = async (driverId) => {
    // Count rides in last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentRides = await Transaction.countDocuments({
        driverId,
        status: "successful",
        type: { $in: ["ride_payment", "cash_in"] },
        createdAt: { $gte: thirtyDaysAgo },
    });

    // High-frequency riders (20+/month) → weekly repayments
    // Medium (10-19) → bi-weekly treated as weekly
    // Low (<10) → monthly
    if (recentRides >= 20) return "weekly";
    if (recentRides >= 10) return "weekly";
    return "monthly";
};

/**
 * Check if a high-risk or repeated borrower needs manual review
 */
const requiresManualReview = async (driverId) => {
    const riskScore = await riskScoringService.getRiskScore(driverId);

    // High-risk: grade D requires manual review
    if (riskScore.grade === "D") return { required: true, reason: "High-risk borrower (Grade D)" };

    // Repeated borrower: 3+ previous loans
    const loanCount = await Loan.countDocuments({ driverId });
    if (loanCount >= 3) return { required: true, reason: "Repeated borrower (3+ prior loans)" };

    // Previously defaulted
    const defaulted = await Loan.findOne({ driverId, loanStatus: "defaulted" });
    if (defaulted) return { required: true, reason: "Previously defaulted on a loan" };

    return { required: false };
};

module.exports = {
    checkEligibility,
    determineRepaymentFrequency,
    requiresManualReview,
};
