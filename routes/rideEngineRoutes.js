const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/rideEngineController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: Ride Engine
 *   description: Complete ride lifecycle — request, match, track, complete, pay, rate
 */

// ── PUBLIC (Guest can estimate) ────────────────────────────────────────

/**
 * @swagger
 * /api/rides/estimate:
 *   post:
 *     summary: Estimate fare for a trip
 *     description: Calculate distance, duration, and fare range from coordinates. No auth required — guests can use this.
 *     tags: [Ride Engine]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pickup, destination]
 *             properties:
 *               pickup:
 *                 type: object
 *                 properties:
 *                   latitude: { type: number, example: -1.9441 }
 *                   longitude: { type: number, example: 30.0619 }
 *               destination:
 *                 type: object
 *                 properties:
 *                   latitude: { type: number, example: -1.9536 }
 *                   longitude: { type: number, example: 30.0606 }
 *     responses:
 *       200:
 *         description: Fare estimate
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 distanceKm: { type: number, example: 8.4 }
 *                 durationMinutes: { type: number, example: 24 }
 *                 minimumFare: { type: number, example: 2500 }
 *                 maximumFare: { type: number, example: 3500 }
 *                 suggestedFare: { type: number, example: 3000 }
 */
router.post("/estimate", ctrl.estimateFare);

// ── AUTHENTICATED ENDPOINTS ────────────────────────────────────────────
router.use(authMiddleware);

/**
 * @swagger
 * /api/rides/request:
 *   post:
 *     summary: Request a ride (passenger)
 *     description: Submit a ride request with coordinates, offered fare, and number of backup drivers to notify (1-5).
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pickup, destination, offeredFare]
 *             properties:
 *               pickup:
 *                 type: object
 *                 properties:
 *                   latitude: { type: number }
 *                   longitude: { type: number }
 *                   address: { type: string, example: "Kigali Heights" }
 *               destination:
 *                 type: object
 *                 properties:
 *                   latitude: { type: number }
 *                   longitude: { type: number }
 *                   address: { type: string, example: "Nyabugogo" }
 *               offeredFare: { type: number, example: 3000 }
 *               backupDriverCount: { type: number, example: 3, minimum: 1, maximum: 5 }
 *     responses:
 *       201:
 *         description: Ride created and drivers notified
 */
router.post("/request", ctrl.requestRide);

/**
 * @swagger
 * /api/rides/my-rides:
 *   get:
 *     summary: Get passenger ride history
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated ride history
 */
router.get("/my-rides", ctrl.getMyRides);

/**
 * @swagger
 * /api/rides/{id}:
 *   get:
 *     summary: Get ride details by ID
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ride details
 */
router.get("/:id", ctrl.getRideById);

/**
 * @swagger
 * /api/rides/{id}/status:
 *   get:
 *     summary: Get real-time ride status
 *     description: Returns full ride data for assigned driver/passenger. For notified-but-unassigned drivers, masks exact pickup location.
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ride status
 */
router.get("/:id/status", ctrl.getRideStatus);

/**
 * @swagger
 * /api/rides/{id}/accept:
 *   post:
 *     summary: Accept a ride request (driver)
 *     description: Atomically assigns the ride to the first driver who accepts. Other drivers get "already assigned."
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ride accepted
 */
router.post("/:id/accept", ctrl.acceptRide);

/**
 * @swagger
 * /api/rides/{id}/decline:
 *   post:
 *     summary: Decline a ride request (driver)
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ride declined
 */
router.post("/:id/decline", ctrl.declineRide);

/**
 * @swagger
 * /api/rides/{id}/arrived:
 *   post:
 *     summary: Driver arrived at pickup point
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Marked as arrived
 */
router.post("/:id/arrived", ctrl.driverArrived);

/**
 * @swagger
 * /api/rides/{id}/start:
 *   post:
 *     summary: Start the ride (requires passenger PIN)
 *     description: Driver enters the 4-digit PIN shown on the passenger's screen to confirm correct pickup.
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pin]
 *             properties:
 *               pin: { type: string, example: "4821" }
 *     responses:
 *       200:
 *         description: Ride started
 */
router.post("/:id/start", ctrl.startRide);

/**
 * @swagger
 * /api/rides/{id}/complete:
 *   post:
 *     summary: Complete the ride (driver)
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ride completed
 */
router.post("/:id/complete", ctrl.completeRide);

/**
 * @swagger
 * /api/rides/{id}/cancel:
 *   post:
 *     summary: Cancel a ride (passenger or driver)
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string, example: "Changed my mind" }
 *     responses:
 *       200:
 *         description: Ride cancelled
 */
router.post("/:id/cancel", ctrl.cancelRide);

/**
 * @swagger
 * /api/rides/{id}/rating:
 *   post:
 *     summary: Rate a completed ride
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: number, minimum: 1, maximum: 5, example: 5 }
 *               comment: { type: string, example: "Great driver!" }
 *     responses:
 *       200:
 *         description: Rating submitted
 */
router.post("/:id/rating", ctrl.rateRide);
router.post("/:id/rate", ctrl.rateRide);

/**
 * @swagger
 * /api/rides/{id}/report:
 *   post:
 *     summary: Report a problem with a ride
 *     tags: [Ride Engine]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               issue: { type: string, example: "Safety concern" }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Report submitted
 */
router.post("/:id/report", ctrl.reportRide);

module.exports = router;
