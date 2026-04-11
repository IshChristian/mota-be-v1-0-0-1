const express = require("express");
const router = express.Router();
const transferController = require("../controllers/transferController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: Transfers
 *   description: Peer-to-peer money transfers
 */

// All transfer routes require authentication
router.use(authMiddleware);

/**
 * @swagger
 * /api/transfer/send:
 *   post:
 *     summary: Send money to another user (direct transfer)
 *     description: |
 *       Transfer money from your wallet to another user identified by phone number.
 *       A transfer fee is deducted from the sender's balance based on system settings.
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - amount
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Receiver's phone number
 *                 example: "+250788123456"
 *               amount:
 *                 type: number
 *                 description: Amount to send in RWF
 *                 example: 5000
 *               description:
 *                 type: string
 *                 description: Optional transfer description
 *                 example: "Payment for services"
 *     responses:
 *       200:
 *         description: Transfer successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 reference:
 *                   type: string
 *                 amount:
 *                   type: number
 *                 fee:
 *                   type: number
 *                 totalDeducted:
 *                   type: number
 *                 senderBalance:
 *                   type: number
 *       400:
 *         description: Invalid request or insufficient balance
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post("/send", transferController.sendMoney);

/**
 * @swagger
 * /api/transfer/send-qr:
 *   post:
 *     summary: Send money via QR code scan
 *     description: |
 *       After scanning a receiver's QR code, submit the decoded phone and amount
 *       to complete the transfer. Same as direct transfer but tagged as QR method.
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - amount
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Receiver's phone number (from scanned QR)
 *                 example: "+250788123456"
 *               amount:
 *                 type: number
 *                 description: Amount to send in RWF
 *                 example: 3000
 *               description:
 *                 type: string
 *                 example: "QR payment"
 *     responses:
 *       200:
 *         description: QR transfer successful
 *       400:
 *         description: Invalid request or insufficient balance
 *       401:
 *         description: Not authenticated
 */
router.post("/send-qr", transferController.sendMoneyQR);

/**
 * @swagger
 * /api/transfer/qr-code:
 *   get:
 *     summary: Generate QR code for receiving payments
 *     description: |
 *       Generates a QR code containing the authenticated user's payment details.
 *       The QR can optionally include a preset amount.
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: amount
 *         in: query
 *         schema:
 *           type: number
 *         description: Optional preset amount to embed in QR
 *         example: 5000
 *     responses:
 *       200:
 *         description: QR code generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 qr_image:
 *                   type: string
 *                   description: Base64 QR code image (data URL)
 *                 qr_data:
 *                   type: string
 *                   description: Raw JSON string embedded in QR
 *                 payload:
 *                   type: object
 *       401:
 *         description: Not authenticated
 */
router.get("/qr-code", transferController.generateQRCode);

/**
 * @swagger
 * /api/transfer/history:
 *   get:
 *     summary: Get transfer history
 *     description: Lists all sent and received transfers for the authenticated user
 *     tags: [Transfers]
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
 *         description: Paginated transfer list with direction indicator
 *       401:
 *         description: Not authenticated
 */
router.get("/history", transferController.getTransferHistory);

module.exports = router;
