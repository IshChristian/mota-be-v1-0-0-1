const express = require("express");
const router = express.Router();
const algorithmController = require("../controllers/algorithmController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Algorithm Engine
 *   description: MOTA Algorithm Engine — ride processing, tiers, streaks, trophies, earnings, revenue
 */

/**
 * @swagger
 * /api/ride/complete:
 *   post:
 *     summary: Process a completed ride through the Algorithm Engine
 *     description: |
 *       Increments daily/monthly rides, updates streak, recalculates tier,
 *       unlocks features, checks trophies, and calculates earnings.
 *       This is an idempotent operation per ride event.
 *     tags: [Algorithm Engine]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Ride processed with updated algorithm data
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
 *                     daily_rides:
 *                       type: number
 *                     monthly_rides:
 *                       type: number
 *                     current_tier:
 *                       type: string
 *                       enum: [Bronze, Silver, Gold, Platinum]
 *                     streak_days:
 *                       type: number
 *                     features_unlocked:
 *                       type: array
 *                       items:
 *                         type: string
 *                     trophies:
 *                       type: array
 *                       items:
 *                         type: string
 *                     daily_earnings:
 *                       type: number
 *                     cycle_number:
 *                       type: number
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post(
    "/complete",
    authMiddleware,
    roleMiddleware("driver"),
    algorithmController.completeRide
);

/**
 * @swagger
 * /api/rider/status:
 *   get:
 *     summary: Get rider algorithm status
 *     description: Returns current tier, streak, daily/monthly rides, features, trophies
 *     tags: [Algorithm Engine]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Rider status data
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/status",
    authMiddleware,
    algorithmController.getRiderStatus
);

/**
 * @swagger
 * /api/rider/status/{id}:
 *   get:
 *     summary: Get rider algorithm status by ID (admin)
 *     tags: [Algorithm Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Rider status data
 */
router.get(
    "/status/:id",
    authMiddleware,
    roleMiddleware("admin", "manager"),
    algorithmController.getRiderStatus
);

/**
 * @swagger
 * /api/rider/earnings:
 *   get:
 *     summary: Get rider earnings calculation
 *     description: |
 *       Returns base pay, tier multiplier, daily/monthly estimated earnings
 *     tags: [Algorithm Engine]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Earnings data
 */
router.get(
    "/earnings",
    authMiddleware,
    algorithmController.getRiderEarnings
);

/**
 * @swagger
 * /api/rider/earnings/{id}:
 *   get:
 *     summary: Get rider earnings by ID (admin)
 *     tags: [Algorithm Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Earnings data
 */
router.get(
    "/earnings/:id",
    authMiddleware,
    roleMiddleware("admin", "manager"),
    algorithmController.getRiderEarnings
);

module.exports = router;
