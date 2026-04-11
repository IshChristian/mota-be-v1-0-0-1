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
 *     summary: Get full wallet summary with all calculated amounts
 *     description: |
 *       Returns a comprehensive wallet overview including:
 *       - **balance**: current wallet balance
 *       - **today**: today's income, expenses, net, fees, per-type breakdown
 *       - **thisWeek**: weekly income, expenses, net
 *       - **thisMonth**: monthly income, expenses, net
 *       - **allTime**: lifetime totals
 *       - **fines**: total fines, by status, remaining amounts, full list
 *       - **recentTransactions**: last 20 transactions
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Full wallet summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 balance:
 *                   type: number
 *                   description: Current wallet balance in RWF
 *                   example: 45000
 *                 fuelCredits:
 *                   type: number
 *                   example: 0
 *                 today:
 *                   type: object
 *                   properties:
 *                     income:
 *                       type: number
 *                       description: Total money received today
 *                       example: 12000
 *                     expenses:
 *                       type: number
 *                       description: Total money spent today
 *                       example: 3000
 *                     net:
 *                       type: number
 *                       description: Net today (income - expenses)
 *                       example: 9000
 *                     fees:
 *                       type: number
 *                       description: Total fees paid today
 *                       example: 200
 *                     breakdown:
 *                       type: object
 *                       description: Per-type breakdown (ride_payment, cash_in, etc.)
 *                 thisWeek:
 *                   type: object
 *                   properties:
 *                     income:
 *                       type: number
 *                     expenses:
 *                       type: number
 *                     net:
 *                       type: number
 *                     fees:
 *                       type: number
 *                     transactionCount:
 *                       type: number
 *                 thisMonth:
 *                   type: object
 *                   properties:
 *                     income:
 *                       type: number
 *                     expenses:
 *                       type: number
 *                     net:
 *                       type: number
 *                     fees:
 *                       type: number
 *                     transactionCount:
 *                       type: number
 *                 allTime:
 *                   type: object
 *                   properties:
 *                     totalIncome:
 *                       type: number
 *                     totalExpenses:
 *                       type: number
 *                     totalFees:
 *                       type: number
 *                     totalTransactions:
 *                       type: number
 *                 fines:
 *                   type: object
 *                   properties:
 *                     totalFines:
 *                       type: number
 *                       description: Total number of fines
 *                       example: 3
 *                     totalAmount:
 *                       type: number
 *                       description: Sum of all fine base amounts
 *                       example: 30000
 *                     totalWithInterest:
 *                       type: number
 *                       description: Sum of all fines including interest
 *                       example: 31500
 *                     totalPaid:
 *                       type: number
 *                       description: Total amount already paid toward fines
 *                       example: 15000
 *                     remaining:
 *                       type: number
 *                       description: Remaining fine balance (totalWithInterest - totalPaid)
 *                       example: 16500
 *                     byStatus:
 *                       type: object
 *                       description: Fine counts and amounts grouped by status (pending, approved, paid, etc.)
 *                     list:
 *                       type: array
 *                       description: Full list of all fine records
 *                 recentTransactions:
 *                   type: array
 *                   description: Last 20 transactions
 *       401:
 *         description: Not authenticated
 */
router.get("/balance", walletController.getBalance);

/**
 * @swagger
 * /api/wallet/summary:
 *   get:
 *     summary: Get wallet summary (alias with wrapper)
 *     description: Same data as /balance but wrapped in { message, data } envelope
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet summary with envelope
 *       401:
 *         description: Not authenticated
 */
router.get("/summary", walletController.getSummary);

/**
 * @swagger
 * /api/wallet/transactions:
 *   get:
 *     summary: Get transaction history (paginated, filterable)
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
 *       - name: type
 *         in: query
 *         schema:
 *           type: string
 *           enum: [ride_payment, platform_commission, cash_in, cash_out, cash_out_fee, agent_cash_in, fine_payment, fine_loan_issued, fine_loan_repayment, referral_reward, admin_credit, commission, agent_registration_fee, agent_pay_fine, cash_out_refund, transaction_fee, p2p_transfer_sent, p2p_transfer_received, p2p_transfer_fee]
 *         description: Optional filter by transaction type
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
