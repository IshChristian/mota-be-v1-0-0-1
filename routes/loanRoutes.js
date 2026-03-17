const express = require("express");
const router = express.Router();
const loanController = require("../controllers/loanController");
const { protect } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Loans
 *   description: Fine loan management for drivers and admins
 */

// All loan routes require authentication
router.use(protect);

// ─── Driver Routes ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/loans/request:
 *   post:
 *     summary: Request a fine loan
 *     tags: [Loans]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fineId]
 *             properties:
 *               fineId:
 *                 type: string
 *                 description: MongoDB _id of the fine
 *     responses:
 *       201:
 *         description: Loan request submitted
 *       400:
 *         description: Invalid request
 */
router.post("/request", roleMiddleware("driver"), loanController.requestLoan);

/**
 * @swagger
 * /api/loans/my-loans:
 *   get:
 *     summary: View my loans
 *     tags: [Loans]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of driver's loans
 */
router.get("/my-loans", roleMiddleware("driver"), loanController.getMyLoans);

/**
 * @swagger
 * /api/loans/repay:
 *   post:
 *     summary: Manually repay a loan from wallet
 *     tags: [Loans]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [loanId, amount]
 *             properties:
 *               loanId: { type: string }
 *               amount: { type: number }
 *     responses:
 *       200:
 *         description: Repayment successful
 */
router.post("/repay", roleMiddleware("driver"), loanController.repayLoan);

// ─── Admin Routes ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/loans/admin/all:
 *   get:
 *     summary: List all loans (admin)
 *     tags: [Loans]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [pending, active, completed, defaulted, rejected]
 *       - name: page
 *         in: query
 *         schema: { type: integer, default: 1 }
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated loan list
 */
router.get("/admin/all", roleMiddleware("admin"), loanController.getAllLoans);

/**
 * @swagger
 * /api/loans/admin/approve:
 *   post:
 *     summary: Approve or reject a loan
 *     tags: [Loans]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [loanId, action]
 *             properties:
 *               loanId: { type: string }
 *               action:
 *                 type: string
 *                 enum: [approve, reject]
 *     responses:
 *       200:
 *         description: Loan approved or rejected
 */
router.post("/admin/approve", roleMiddleware("admin"), loanController.approveLoan);

module.exports = router;
