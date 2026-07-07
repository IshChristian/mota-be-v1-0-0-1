const express = require("express");
const router = express.Router();
const financeController = require("../controllers/financeController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Finance
 *   description: Rider-Finance Platform (Loans, Savings, Risk, Migration)
 */

router.use(authMiddleware);

/**
 * @swagger
 * /api/finance/eligibility:
 *   get:
 *     summary: Check loan eligibility and maximum amount
 *     description: Evaluates all 10 lending rules (KYC, active account, no arrears, min transactions, risk score) to determine if the rider can request a fine loan.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Eligibility result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 eligible:
 *                   type: boolean
 *                 reason:
 *                   type: string
 *                 maxAmount:
 *                   type: number
 *                 riskScore:
 *                   type: object
 */
router.get("/eligibility", roleMiddleware("driver"), financeController.checkEligibility);

/**
 * @swagger
 * /api/finance/risk-score:
 *   get:
 *     summary: Get driver's own risk score
 *     description: Returns the calculated 0-1000 credit score, grade (A-F), and factor breakdown.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Risk score details
 */
router.get("/risk-score", roleMiddleware("driver"), financeController.getRiskScore);

/**
 * @swagger
 * /api/finance/loans/{id}/schedule:
 *   get:
 *     summary: Get loan repayment schedule
 *     description: Returns the structured installment plan for a specific loan.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Loan ID
 *     responses:
 *       200:
 *         description: Repayment schedule
 */
router.get("/loans/:id/schedule", financeController.getRepaymentSchedule);

// --- Savings (Keep Me in Bank) ---

/**
 * @swagger
 * /api/finance/savings/status:
 *   get:
 *     summary: Get savings account summary
 *     description: Returns the Keep Me in Bank balance, total deposited/withdrawn, reward accrued, and whether the balance has been held for 30+ days.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Savings status
 */
router.get("/savings/status", roleMiddleware("driver"), financeController.getSavingsStatus);

/**
 * @swagger
 * /api/finance/savings/deposit:
 *   post:
 *     summary: Deposit to savings from wallet
 *     description: Transfers funds from the driver's active wallet into their savings account.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: number
 *     responses:
 *       200:
 *         description: Deposit successful
 */
router.post("/savings/deposit", roleMiddleware("driver"), financeController.depositSavings);

/**
 * @swagger
 * /api/finance/savings/withdraw:
 *   post:
 *     summary: Withdraw from savings to wallet
 *     description: Transfers funds from the savings account back to the active wallet.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: number
 *     responses:
 *       200:
 *         description: Withdrawal successful
 */
router.post("/savings/withdraw", roleMiddleware("driver"), financeController.withdrawSavings);

// --- Migration ---

/**
 * @swagger
 * /api/finance/migration-stage:
 *   get:
 *     summary: Get driver's current migration stage
 *     description: Returns the current stage in the adoption funnel (e.g., fine_entry, repayment_trust, transaction_adoption, savings_adoption).
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Migration stage details
 */
router.get("/migration-stage", roleMiddleware("driver"), financeController.getMigrationStage);

// --- Compliance / Consent ---

/**
 * @swagger
 * /api/finance/consent:
 *   post:
 *     summary: Capture driver consent
 *     description: Records explicit user consent for compliance (data_processing, lending_terms, etc).
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - consentType
 *             properties:
 *               consentType:
 *                 type: string
 *                 enum: [data_processing, lending_terms, savings_terms, sms_notifications, credit_check]
 *               version:
 *                 type: string
 *                 example: "v1.0"
 *               channel:
 *                 type: string
 *                 enum: [app, ussd, sms]
 *                 default: app
 *     responses:
 *       200:
 *         description: Consent captured
 */
router.post("/consent", roleMiddleware("driver"), financeController.captureConsent);

/**
 * @swagger
 * /api/finance/consent:
 *   get:
 *     summary: Get driver's consent status
 *     description: Returns a list of all active consents provided by the driver.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of consents
 */
router.get("/consent", roleMiddleware("driver"), financeController.getConsentStatus);

module.exports = router;
