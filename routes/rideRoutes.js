const express = require("express");
const router = express.Router();
const rideController = require("../controllers/rideController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: Rides
 *   description: Ride management
 */

/**
 * @swagger
 * /api/ride/{id}:
 *   get:
 *     summary: Get ride details by ID
 *     tags: [Rides]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Ride ID (MongoDB ObjectId)
 *     responses:
 *       200:
 *         description: Ride details
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Ride not found
 *       500:
 *         description: Server error
 */
router.get("/:id", authMiddleware, rideController.getRideById);

module.exports = router;
