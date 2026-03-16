const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Payments
 *   description: Ride payment processing via Paypack
 */

/**
 * @swagger
 * /api/payment/request:
 *   post:
 *     summary: Request ride payment from passenger via Paypack
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - passengerPhone
 *               - amount
 *             properties:
 *               passengerPhone:
 *                 type: string
 *                 example: "+250788654321"
 *               amount:
 *                 type: number
 *                 example: 1500
 *               rideId:
 *                 type: string
 *                 description: Ride ID to link payment to
 *     responses:
 *       200:
 *         description: Payment request sent to passenger
 *       400:
 *         description: Missing fields
 *       502:
 *         description: Payment gateway error
 */
router.post("/request", authMiddleware, roleMiddleware("driver"), paymentController.requestPayment);

/**
 * @swagger
 * /api/payment/webhook:
 *   post:
 *     summary: Paypack payment webhook (called by Paypack)
 *     tags: [Payments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ref:
 *                 type: string
 *               status:
 *                 type: string
 *               amount:
 *                 type: number
 *               kind:
 *                 type: string
 *     responses:
 *       200:
 *         description: Webhook processed
 */
router.post("/webhook", paymentController.handleWebhook);

module.exports = router;
