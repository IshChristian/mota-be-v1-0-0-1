const express = require("express");
const router = express.Router();
const walletController = require("../controllers/walletController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Wallet
 *   description: Driver wallet management
 */

// All wallet routes require driver auth
router.use(authMiddleware, roleMiddleware("driver"));

/**
 * @swagger
 * /api/wallet/balance:
 *   get:
 *     summary: Get wallet balance and recent transactions
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet balance and last 20 transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 balance:
 *                   type: number
 *                   example: 12000
 *                 fuelCredits:
 *                   type: number
 *                   example: 0
 *                 transactions:
 *                   type: array
 *       401:
 *         description: Not authenticated
 */
router.get("/balance", walletController.getBalance);

/**
 * @swagger
 * /api/wallet/transactions:
 *   get:
 *     summary: Get transaction history (paginated)
 *     tags: [Wallet]
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
 *         description: Paginated transaction list
 */
router.get("/transactions", walletController.getTransactions);

/**
 * @swagger
 * /api/wallet/cash-in:
 *   post:
 *     summary: Initiate digital cash-in via Paypack
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: number
 *                 example: 5000
 *               phone:
 *                 type: string
 *                 description: Phone to charge (defaults to driver's phone)
 *                 example: "+250788123456"
 *     responses:
 *       200:
 *         description: Cash-in request initiated
 *       400:
 *         description: Invalid amount
 *       502:
 *         description: Payment gateway error
 */
router.post("/cash-in", walletController.cashIn);

/**
 * @swagger
 * /api/wallet/cash-out:
 *   post:
 *     summary: Request a cash-out (withdrawal) — pending admin approval
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: number
 *                 example: 10000
 *     responses:
 *       200:
 *         description: Cash-out request submitted
 *       400:
 *         description: Insufficient balance or invalid amount
 */
router.post("/cash-out", walletController.requestCashOut);

module.exports = router;
