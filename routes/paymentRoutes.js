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

/**
 * @swagger
 * /api/payment/status/{ref}:
 *   get:
 *     summary: Check transaction status (one-shot poll)
 *     description: |
 *       Returns the current status of a transaction by its Paypack reference.
 *       Use this for a single status check. For real-time updates, use the
 *       SSE endpoint `/api/payment/status-stream/{ref}` instead.
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: ref
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Paypack transaction reference returned from log-ride
 *         example: "pp_ref_abc123xyz"
 *     responses:
 *       200:
 *         description: Transaction status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ref:
 *                   type: string
 *                   example: "pp_ref_abc123xyz"
 *                 status:
 *                   type: string
 *                   enum: [pending, completed, failed]
 *                   example: "pending"
 *                 amount:
 *                   type: number
 *                   example: 3000
 *                 type:
 *                   type: string
 *                   example: "cash_in"
 *                 description:
 *                   type: string
 *                 ride:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     rideId:
 *                       type: string
 *                     paymentStatus:
 *                       type: string
 *                       enum: [pending, completed, failed]
 *                     fare:
 *                       type: number
 *                     passengerPhone:
 *                       type: string
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *       403:
 *         description: Access denied (transaction belongs to another driver)
 *       404:
 *         description: Transaction not found
 *       500:
 *         description: Server error
 */
router.get("/status/:ref", authMiddleware, paymentController.getTransactionStatus);

/**
 * @swagger
 * /api/payment/status-stream/{ref}:
 *   get:
 *     summary: Real-time transaction status stream (Server-Sent Events)
 *     description: |
 *       Opens a persistent SSE (Server-Sent Events) connection that streams
 *       transaction status updates in real-time.
 *
 *       **How it works:**
 *       1. Sends the current status immediately on connect.
 *       2. Pushes an instant update when Paypack webhook confirms payment.
 *       3. Falls back to polling every **3 seconds** as a safety net.
 *       4. Automatically closes when status becomes `completed` or `failed`.
 *       5. Auto-closes after **5 minutes** if still pending.
 *
 *       **Client-side usage (JavaScript):**
 *       ```js
 *       const ref = "pp_ref_abc123xyz";
 *       const token = "<your_jwt_token>";
 *       const es = new EventSource(
 *         `/api/payment/status-stream/${ref}?token=${token}`
 *       );
 *       es.onmessage = (e) => {
 *         const data = JSON.parse(e.data);
 *         console.log(data.status); // "pending" | "successful" | "failed"
 *         if (data.status === "successful" || data.status === "failed") {
 *           es.close();
 *         }
 *       };
 *       ```
 *
 *       **Event payload shape:**
 *       ```json
 *       {
 *         "ref": "pp_ref_abc123xyz",
 *         "status": "successful",
 *         "amount": 3000,
 *         "type": "cash_in",
 *         "description": "Cash In via MoMo...",
 *         "ride": {
 *           "rideId": "664abc...",
 *           "paymentStatus": "successful",
 *           "fare": 3000,
 *           "passengerPhone": "+250782123456"
 *         },
 *         "timestamp": "2026-05-05T21:35:00.000Z"
 *       }
 *       ```
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: ref
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Paypack transaction reference returned from log-ride
 *         example: "pp_ref_abc123xyz"
 *     responses:
 *       200:
 *         description: SSE stream of transaction status events
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: "data: {\"ref\":\"pp_ref_abc123xyz\",\"status\":\"pending\",\"amount\":3000}\n\n"
 *       400:
 *         description: Missing ref parameter
 *       403:
 *         description: Access denied
 *       404:
 *         description: Transaction not found (sent as SSE event then stream closed)
 */
router.get("/status-stream/:ref", authMiddleware, paymentController.streamTransactionStatus);

module.exports = router;
