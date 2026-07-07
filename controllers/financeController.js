const riskScoringService = require("../services/riskScoringService");
const lendingPolicyService = require("../services/lendingPolicyService");
const savingsService = require("../services/savingsService");
const migrationService = require("../services/migrationService");
const repaymentService = require("../services/repaymentService");
const Consent = require("../models/Consent");
const auditService = require("../services/auditService");

/**
 * @route GET /api/finance/eligibility
 * @desc Check loan eligibility and max amount
 */
const checkEligibility = async (req, res) => {
    try {
        const result = await lendingPolicyService.checkEligibility(req.user.id);
        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ message: "Failed to check eligibility", error: err.message });
    }
};

/**
 * @route GET /api/finance/risk-score
 * @desc Get driver's own risk score
 */
const getRiskScore = async (req, res) => {
    try {
        const score = await riskScoringService.getRiskScore(req.user.id);
        res.status(200).json(score);
    } catch (err) {
        res.status(500).json({ message: "Failed to get risk score", error: err.message });
    }
};

/**
 * @route GET /api/finance/loans/:id/schedule
 * @desc Get loan repayment schedule
 */
const getRepaymentSchedule = async (req, res) => {
    try {
        const schedule = await repaymentService.getSchedule(req.params.id);
        if (!schedule) return res.status(404).json({ message: "Schedule not found" });
        if (schedule.driverId.toString() !== req.user.id && req.user.role !== "admin") {
            return res.status(403).json({ message: "Unauthorized" });
        }
        res.status(200).json(schedule);
    } catch (err) {
        res.status(500).json({ message: "Error fetching schedule", error: err.message });
    }
};

/**
 * @route GET /api/finance/savings/status
 * @desc Get savings account summary
 */
const getSavingsStatus = async (req, res) => {
    try {
        const summary = await savingsService.getAccountSummary(req.user.id);
        res.status(200).json(summary);
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch savings status", error: err.message });
    }
};

/**
 * @route POST /api/finance/savings/deposit
 * @desc Deposit to savings from wallet
 */
const depositSavings = async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount" });

        const result = await savingsService.deposit(req.user.id, amount, "wallet");
        
        // Advance migration stage
        await migrationService.evaluateAndAdvanceStage(req.user.id, "savings_deposited");

        res.status(200).json({ message: "Deposit successful", data: result });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

/**
 * @route POST /api/finance/savings/withdraw
 * @desc Withdraw from savings to wallet
 */
const withdrawSavings = async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount" });

        const result = await savingsService.withdraw(req.user.id, amount, "wallet");
        res.status(200).json({ message: "Withdrawal successful", data: result });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

/**
 * @route GET /api/finance/migration-stage
 * @desc Get driver's current migration stage
 */
const getMigrationStage = async (req, res) => {
    try {
        const stage = await migrationService.getOrCreateMigrationStage(req.user.id);
        res.status(200).json(stage);
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch migration stage", error: err.message });
    }
};

/**
 * @route POST /api/finance/consent
 * @desc Capture driver consent
 */
const captureConsent = async (req, res) => {
    try {
        const { consentType, version, channel } = req.body;
        const consent = await Consent.findOneAndUpdate(
            { driverId: req.user.id, consentType },
            { 
                version: version || "v1.0",
                channel: channel || "app",
                consentedAt: new Date(),
                ipAddress: req.ip,
                revokedAt: null
            },
            { upsert: true, new: true }
        );

        await auditService.log({
            actorId: req.user.id,
            actorRole: "driver",
            action: "consent_captured",
            targetType: "Consent",
            targetId: consent._id,
            metadata: { consentType, version, channel },
            ipAddress: req.ip
        });

        res.status(200).json({ message: "Consent captured", consent });
    } catch (err) {
        res.status(500).json({ message: "Failed to capture consent", error: err.message });
    }
};

/**
 * @route GET /api/finance/consent
 * @desc Get driver's consent status
 */
const getConsentStatus = async (req, res) => {
    try {
        const consents = await Consent.find({ driverId: req.user.id });
        res.status(200).json(consents);
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch consent status", error: err.message });
    }
};

module.exports = {
    checkEligibility,
    getRiskScore,
    getRepaymentSchedule,
    getSavingsStatus,
    depositSavings,
    withdrawSavings,
    getMigrationStage,
    captureConsent,
    getConsentStatus,
};
