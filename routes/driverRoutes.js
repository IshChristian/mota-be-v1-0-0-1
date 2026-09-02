const express = require("express");
const router = express.Router();
const driverController = require("../controllers/driverController");
const rideController = require("../controllers/rideController");
const rideEngineController = require("../controllers/rideEngineController");
const tierController = require("../controllers/tierController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
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
 *     summary: Log a ride and initiate MoMo cash-in
 *     description: |
 *       Logs a ride for the authenticated driver and sends a MoMo payment request
 *       to the passenger's phone via Paypack. The ride is saved with
 *       `paymentStatus: pending`. The wallet is credited and streak/tier updated
 *       after Paypack confirms the payment via webhook.
 *
 *       **Phone number rules:**
 *       The passenger phone must be a valid Rwandan number in one of these formats:
 *       - `+2507XXXXXXXX` (accepted as-is)
 *       - `07XXXXXXXX` (auto-prefixed to `+250`)
 *       - `7XXXXXXXX` (auto-prefixed to `+250`)
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
 *               - passengerPhone
 *             properties:
 *               fare:
 *                 type: number
 *                 description: Ride fare in RWF (must be greater than 0)
 *                 example: 3000
 *               passengerPhone:
 *                 type: string
 *                 description: Passenger phone number (Rwandan — +250 / 07 / 7 prefix)
 *                 example: "0782123456"
 *               paymentMethod:
 *                 type: string
 *                 enum: [momo, wallet]
 *                 default: momo
 *                 description: Payment method (defaults to momo)
 *                 example: "momo"
 *               date:
 *                 type: string
 *                 format: date-time
 *                 description: Optional ride date/time (defaults to now)
 *                 example: "2026-05-05T10:30:00.000Z"
 *     responses:
 *       201:
 *         description: Ride logged and MoMo payment request sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Ride logged. MoMo payment request sent to passenger's phone."
 *                 ride:
 *                   type: object
 *                   properties:
 *                     _id:
 *                       type: string
 *                       example: "664abc123def456789"
 *                     fare:
 *                       type: number
 *                       example: 3000
 *                     passengerPhone:
 *                       type: string
 *                       example: "+250782123456"
 *                     paymentStatus:
 *                       type: string
 *                       enum: [pending, completed, failed]
 *                       example: "pending"
 *                     paymentMethod:
 *                       type: string
 *                       example: "momo"
 *                     driverEarning:
 *                       type: number
 *                       example: 2700
 *                     commission:
 *                       type: number
 *                       example: 300
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                 paypackRef:
 *                   type: string
 *                   description: Paypack transaction reference (null if initiation failed)
 *                   example: "pp_ref_xyz123"
 *                 paypackStatus:
 *                   type: string
 *                   enum: [pending, failed, error, not_initiated]
 *                   example: "pending"
 *                 ridesToday:
 *                   type: number
 *                   description: Number of completed rides today (paymentStatus=completed only)
 *                   example: 5
 *                 target:
 *                   type: number
 *                   example: 20
 *                 currentStreak:
 *                   type: number
 *                   example: 3
 *                 tier:
 *                   type: string
 *                   example: "silver"
 *                 algorithm:
 *                   type: object
 *                   nullable: true
 *       400:
 *         description: Missing or invalid fields (fare, phone format, payment method)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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

/**
 * @swagger
 * /api/driver/pay-fine:
 *   post:
 *     summary: Pay driver fine
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
 *               - fineId
 *             properties:
 *               fineId:
 *                 type: string
 *               paymentAmount:
 *                 type: number
 *                 description: Optional amount to pay (defaults to full balance)
 *     responses:
 *       200:
 *         description: Fine paid successful (fully or partially)
 *       400:
 *         description: Bad request or insufficient funds
 *       404:
 *         description: Fine not found
 */
router.post("/pay-fine", authMiddleware, roleMiddleware("driver"), driverController.payFine);

/**
 * @swagger
 * /api/driver/request-fine:
 *   post:
 *     summary: Request admin to review a fine
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
 *               - fineId
 *             properties:
 *               fineId:
 *                 type: string
 *               amount:
 *                 type: number
 *                 description: Optional. The fine amount if known.
 *     responses:
 *       201:
 *         description: Fine payment request submitted successfully
 *       400:
 *         description: Active fine request already exists or missing data
 *       500:
 *         description: Server error
 */
router.post("/request-fine", authMiddleware, roleMiddleware("driver"), driverController.requestFinePayment);

/**
 * @swagger
 * /api/driver/availability:
 *   put:
 *     summary: Toggle driver online/offline status
 *     description: Set driver as available or unavailable for ride requests. Cannot go offline during an active ride.
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isOnline]
 *             properties:
 *               isOnline:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Availability updated
 *       400:
 *         description: Cannot go offline during active ride
 */
router.put("/availability", authMiddleware, roleMiddleware("driver"), rideEngineController.setAvailability);

/**
 * @swagger
 * /api/driver/active-ride:
 *   get:
 *     summary: Get driver's current active ride
 *     description: Returns the ride the driver is currently assigned to (accepted, arriving, arrived, or in_progress). Returns null if no active ride.
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active ride or null
 */
router.get("/active-ride", authMiddleware, roleMiddleware("driver"), rideEngineController.getActiveRide);

/**
 * @swagger
 * /api/driver/location:
 *   put:
 *     summary: Update driver real-time location via REST
 *     tags: [Driver]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [latitude, longitude]
 *             properties:
 *               latitude: { type: number }
 *               longitude: { type: number }
 *               heading: { type: number }
 *               speed: { type: number }
 *     responses:
 *       200:
 *         description: Location updated
 */
router.put("/location", authMiddleware, roleMiddleware("driver"), rideEngineController.updateLocation);

module.exports = router;
