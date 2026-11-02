const express = require("express");
const router = express.Router();
const algorithmController = require("../controllers/algorithmController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const SystemConfig = require("../models/SystemConfig");

// Public release metadata contains only version and administrator-approved HTTPS destinations.
/** Prices, fees and contacts set in the admin panel, so the apps never show stale hard-coded figures. */
router.get("/pricing", async (_req, res) => {
    try {
        const { getSetting } = require("../services/systemSettingService");
        const num = async (key, fallback) => { const v = Number(await getSetting(key, fallback)); return Number.isFinite(v) ? v : fallback; };
        const on = async (key, fallback) => { const v = await getSetting(key, fallback); return v === true || v === "true"; };
        res.set("Cache-Control", "public, max-age=60");
        res.json({ data: {
            appName: await getSetting("app_name", "MOTA"),
            support: { phone: await getSetting("support_phone", ""), email: await getSetting("support_email", "") },
            maintenance: { on: await on("maintenance_mode", false), message: await getSetting("maintenance_message", "") },
            registrationFee: { driver: await num("registration_fee", 5000), agent: await num("agent_registration_fee", 10000) },
            fees: { cashOutPercent: await num("cash_out_fee_percentage", 2), transferPercent: await num("transfer_fee_percentage", 1), commissionPercent: await num("ride_commission_percentage", 10) },
            fares: {
                moto: { base: await num("ride_base_fare", 500), perKm: await num("ride_per_km_rate", 500), minimum: await num("ride_minimum_fare", 500) },
                car: { base: await num("car_ride_base_fare", 1500), perKm: await num("car_ride_per_km_rate", 500), minimum: await num("car_ride_minimum_fare", 2500) },
                parcelSurcharge: await num("parcel_surcharge", 300),
            },
            loans: { interestPercent: await num("fine_loan_interest_rate", 5), maxAmount: await num("fine_loan_max_amount", 50000), autoRepaymentPercent: await num("fine_loan_auto_repayment_percentage", 10), maxDurationDays: await num("fine_loan_max_duration_days", 90) },
            fuel: { voucherAmount: await num("fuel_voucher_amount", 1000), dailyLimit: await num("fuel_voucher_daily_limit", 2) },
            referralReward: await num("referral_reward_amount", 5000),
        } });
    } catch (_error) {
        res.status(503).json({ message: "Pricing is unavailable" });
    }
});

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
