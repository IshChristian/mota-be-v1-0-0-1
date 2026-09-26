const express = require("express");
const router = express.Router();
const algorithmController = require("../controllers/algorithmController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const SystemConfig = require("../models/SystemConfig");

// Public release metadata contains only version and administrator-approved HTTPS destinations.
router.get("/mobile-release", async (_req, res) => {
    try {
        const config = await SystemConfig.findOne({ key: "mobile_release" }).lean();
        const value = config?.value || {};
        const safeUrl = (url) => typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
        res.json({ version: typeof value.version === "string" ? value.version : null, downloaderUrl: safeUrl(value.downloaderUrl), websiteUrl: safeUrl(value.websiteUrl) });
    } catch (_error) {
        res.status(503).json({ message: "Release information is unavailable" });
    }
});

/**
 * @swagger
 * tags:
 *   name: Platform
 *   description: Platform-level revenue and management
 */

/**
 * @swagger
 * /api/platform/revenue:
 *   get:
 *     summary: Get platform revenue breakdown
 *     description: |
 *       Calculates total platform revenue from commissions, fines, fees,
 *       registrations, loan interest, and subtracts referral costs.
 *     tags: [Platform]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Platform revenue data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     fares_commission:
 *                       type: number
 *                     fine_revenue:
 *                       type: number
 *                     cash_out_fees:
 *                       type: number
 *                     transaction_fees:
 *                       type: number
 *                     registration_fees:
 *                       type: number
 *                     loan_interest:
 *                       type: number
 *                     referral_costs:
 *                       type: number
 *                     total:
 *                       type: number
 *                     net_revenue:
 *                       type: number
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not authorized
 */
router.get(
    "/revenue",
    authMiddleware,
    roleMiddleware("admin"),
    algorithmController.getPlatformRevenue
);

/**
 * @swagger
 * /api/platform/cron/daily-reset:
 *   post:
 *     summary: Trigger daily reset (admin/cron)
 *     description: Resets daily_rides to 0 for all riders. Normally runs at 00:00 automatically.
 *     tags: [Platform]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Daily reset executed
 *       403:
 *         description: Not authorized
 */
router.post(
    "/cron/daily-reset",
    authMiddleware,
    roleMiddleware("admin"),
    algorithmController.triggerDailyReset
);

/**
 * @swagger
 * /api/platform/cron/monthly-reset:
 *   post:
 *     summary: Trigger monthly reset (admin/cron)
 *     description: |
 *       Resets monthly_rides and streak for riders whose 30-day cycle has completed.
 *       Stores previous cycle stats. Normally runs daily and checks per-rider cycle dates.
 *     tags: [Platform]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Monthly reset executed
 *       403:
 *         description: Not authorized
 */
router.post(
    "/cron/monthly-reset",
    authMiddleware,
    roleMiddleware("admin"),
    algorithmController.triggerMonthlyReset
);

module.exports = router;
