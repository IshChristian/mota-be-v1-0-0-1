const express = require("express");
const router = express.Router();
const lookupController = require("../controllers/lookupController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Lookup
 *   description: Full user data lookup by plate number or ID
 */

/**
 * @swagger
 * /api/lookup/plate/{plateNumber}:
 *   get:
 *     summary: Get ALL data for a user by plate number
 *     description: |
 *       Fetches comprehensive data including user info, driver profile, loans, fines,
 *       fine requests, referrals, rides, tiers, streak, wallet, transactions, transfers,
 *       notifications, and algorithm engine data for a driver identified by plate number.
 *     tags: [Lookup]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: plateNumber
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver's plate number (e.g. "RAC 123 A")
 *         example: "RAC 123 A"
 *       - name: transactionLimit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Max transactions to return
 *       - name: rideLimit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Max rides to return
 *     responses:
 *       200:
 *         description: Full user data object
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
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     profile:
 *                       $ref: '#/components/schemas/DriverProfile'
 *                     wallet:
 *                       type: object
 *                     tier:
 *                       $ref: '#/components/schemas/Tier'
 *                     streak:
 *                       $ref: '#/components/schemas/Streak'
 *                     algorithm:
 *                       type: object
 *                     rides:
 *                       type: object
 *                     fines:
 *                       type: array
 *                     fineRequests:
 *                       type: array
 *                     loans:
 *                       type: array
 *                     referrals:
 *                       type: object
 *                     transactions:
 *                       type: object
 *                     transfers:
 *                       type: array
 *                     notifications:
 *                       type: array
 *                     financialSummary:
 *                       type: object
 *       404:
 *         description: No driver found with that plate number
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get(
    "/plate/:plateNumber",
    authMiddleware,
    roleMiddleware("admin", "agent", "manager"),
    lookupController.getByPlateNumber
);

/**
 * @swagger
 * /api/lookup/user/{id}:
 *   get:
 *     summary: Get ALL data for a user by user ID
 *     description: |
 *       Same as plate lookup but uses the user's MongoDB ID instead.
 *       Returns comprehensive data for any user type.
 *     tags: [Lookup]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: User's MongoDB ObjectId
 *       - name: transactionLimit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 50
 *       - name: rideLimit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Full user data object
 *       404:
 *         description: User not found
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get(
    "/user/:id",
    authMiddleware,
    roleMiddleware("admin", "agent", "manager"),
    lookupController.getByUserId
);

module.exports = router;
