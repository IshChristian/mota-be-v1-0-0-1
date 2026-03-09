const express = require("express");
const router = express.Router();
const driverController = require("../controllers/driverController");
const rideController = require("../controllers/rideController");
const tierController = require("../controllers/tierController");
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Driver
 *   description: Driver profile and ride management
 */

/**
 * @swagger
 * /api/driver/create-profile:
 *   post:
 *     summary: Create driver profile
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plateNumber
 *               - nid
 *               - insuranceAttachment
 *               - permitAttachment
 *               - permitId
 *             properties:
 *               plateNumber:
 *                 type: string
 *                 example: "RAC 123 A"
 *               cooperativeName:
 *                 type: string
 *                 example: "Kigali Moto Coop"
 *               nid:
 *                 type: string
 *                 example: "1199880012345678"
 *               insuranceAttachment:
 *                 type: string
 *                 example: "https://storage.example.com/insurance.pdf"
 *               permitAttachment:
 *                 type: string
 *                 example: "https://storage.example.com/permit.pdf"
 *               permitId:
 *                 type: string
 *                 example: "DL-2024-001234"
 *     responses:
 *       201:
 *         description: Profile created successfully
 *       400:
 *         description: Missing fields or profile already exists
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post("/create-profile", authMiddleware, roleMiddleware("driver"), driverController.createProfile);

/**
 * @swagger
 * /api/driver/dashboard:
 *   get:
 *     summary: Get driver dashboard data
 *     description: Returns tier, rides today, monthly rides, streak, wallet balance, and referral count
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tier:
 *                   type: string
 *                   enum: [bronze, silver, gold, platinum]
 *                   example: silver
 *                 multiplier:
 *                   type: number
 *                   example: 1.2
 *                 ridesToday:
 *                   type: number
 *                   example: 18
 *                 target:
 *                   type: number
 *                   example: 20
 *                 ridesMonth:
 *                   type: number
 *                   example: 620
 *                 streak:
 *                   type: number
 *                   example: 15
 *                 longestStreak:
 *                   type: number
 *                   example: 30
 *                 wallet:
 *                   type: number
 *                   example: 12000
 *                 referrals:
 *                   type: number
 *                   example: 5
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get("/dashboard", authMiddleware, roleMiddleware("driver"), driverController.getDashboard);

/**
 * @swagger
 * /api/driver/profile:
 *   get:
 *     summary: Get driver profile with user details
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Driver user and profile data
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Server error
 */
router.get("/profile", authMiddleware, roleMiddleware("driver"), driverController.getProfile);

/**
 * @swagger
 * /api/driver/update-profile:
 *   put:
 *     summary: Update driver profile
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               plateNumber:
 *                 type: string
 *                 example: "RAC 456 B"
 *               cooperativeName:
 *                 type: string
 *                 example: "Nyamirambo Coop"
 *               insuranceAttachment:
 *                 type: string
 *               permitAttachment:
 *                 type: string
 *               permitId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Server error
 */
router.put("/update-profile", authMiddleware, roleMiddleware("driver"), driverController.updateProfile);

/**
 * @swagger
 * /api/driver/log-ride:
 *   post:
 *     summary: Log a completed ride
 *     description: Logs a ride and automatically updates daily streak and tier progress
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fare
 *               - paymentMethod
 *             properties:
 *               fare:
 *                 type: number
 *                 description: Ride fare in RWF
 *                 example: 1500
 *               paymentMethod:
 *                 type: string
 *                 enum: [cash, momo]
 *                 example: cash
 *               pickupLocation:
 *                 type: string
 *                 example: "Kicukiro"
 *               dropoffLocation:
 *                 type: string
 *                 example: "Nyabugogo"
 *               distance:
 *                 type: number
 *                 description: Distance in km
 *                 example: 8.5
 *     responses:
 *       201:
 *         description: Ride logged successfully with updated stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 ride:
 *                   type: object
 *                 ridesToday:
 *                   type: number
 *                 target:
 *                   type: number
 *                 currentStreak:
 *                   type: number
 *                 tier:
 *                   type: string
 *       400:
 *         description: Missing or invalid fields
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post("/log-ride", authMiddleware, roleMiddleware("driver"), rideController.logRide);

/**
 * @swagger
 * /api/driver/rides:
 *   get:
 *     summary: Get ride history (paginated)
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated ride history
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get("/rides", authMiddleware, roleMiddleware("driver"), driverController.getRideHistory);

/**
 * @swagger
 * /api/driver/tier:
 *   get:
 *     summary: Get driver tier information
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tier info with thresholds
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tier:
 *                   type: string
 *                   enum: [bronze, silver, gold, platinum]
 *                 totalRides:
 *                   type: number
 *                 monthlyRides:
 *                   type: number
 *                 multiplier:
 *                   type: number
 *                 thresholds:
 *                   type: object
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get("/tier", authMiddleware, roleMiddleware("driver"), tierController.getMyTier);

/**
 * @swagger
 * /api/driver/leaderboard:
 *   get:
 *     summary: Get driver leaderboard
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Top drivers by monthly rides
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get("/leaderboard", authMiddleware, tierController.getLeaderboard);

module.exports = router;
