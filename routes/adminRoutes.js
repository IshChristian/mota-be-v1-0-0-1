const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Require authentication and RBAC for all admin routes, forcing them to have "admin:access"
router.use(protect);
router.use(authorize("admin:access"));

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: System administration and configuration
 */

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Get list of all users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 */
router.get("/users", adminController.getUsersList);

/**
 * @swagger
 * /api/admin/users/{id}/ban:
 *   patch:
 *     summary: Ban a user account
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User banned
 */
router.patch("/users/:id/ban", authorize("user:update"), adminController.banUserAccount);

/**
 * @swagger
 * /api/admin/users/{id}/unban:
 *   patch:
 *     summary: Unban a user account
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User unbanned
 */
router.patch("/users/:id/unban", authorize("user:update"), adminController.unbanUserAccount);

/**
 * @swagger
 * /api/admin/users/{id}:
 *   delete:
 *     summary: Delete a user account permanently
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User deleted
 */
router.delete("/users/:id", authorize("user:delete"), adminController.deleteUserAccount);

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Get system statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System stats
 */
router.get("/stats", authorize("analytics:view"), adminController.getStats);

/**
 * @swagger
 * /api/admin/configs:
 *   get:
 *     summary: Get all system configurations
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of configs
 */
router.get("/configs", authorize("settings:view"), adminController.getSystemConfigs);

/**
 * @swagger
 * /api/admin/configs:
 *   post:
 *     summary: Update or create a system configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               key:
 *                 type: string
 *               value:
 *                 type: object
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Config updated
 */
router.post("/configs", authorize("settings:update"), adminController.updateSystemConfig);

/**
 * @swagger
 * /api/admin/configs/financial:
 *   patch:
 *     summary: Update financial and loan system settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               registration_fee: { type: number, description: "Driver registration fee (RWF)" }
 *               agent_registration_fee: { type: number, description: "Agent registration fee (RWF)" }
 *               ride_commission_percentage: { type: number, description: "Ride commission %" }
 *               cash_out_fee_percentage: { type: number, description: "Cash-out fee %" }
 *               agent_cash_in_fee_percentage: { type: number, description: "Agent cash-in fee %" }
 *               referral_reward_amount: { type: number, description: "Referral reward (RWF)" }
 *               fine_loan_interest_rate: { type: number, description: "Loan interest rate %" }
 *               fine_loan_max_amount: { type: number, description: "Max loan amount (RWF)" }
 *               fine_loan_auto_repayment_percentage: { type: number, description: "Auto-repayment % from rides" }
 *               fine_loan_max_duration_days: { type: number, description: "Max loan duration (days)" }
 *               tier_bronze_rides: { type: number, description: "Bronze tier total rides" }
 *               tier_silver_rides: { type: number, description: "Silver tier total rides" }
 *               tier_gold_rides: { type: number, description: "Gold tier total rides" }
 *               tier_platinum_rides: { type: number, description: "Platinum tier total rides" }
 *               tier_gorilla_rides: { type: number, description: "Gorilla tier total rides" }
 *     responses:
 *       200:
 *         description: Financial and tier settings updated
 */
router.patch("/configs/financial", authorize("settings:financial"), adminController.updateFinancialSettings);

/**
 * @swagger
 * /api/admin/configs/general:
 *   patch:
 *     summary: Update general platform settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               app_name: { type: string }
 *               support_phone: { type: string }
 *               support_email: { type: string }
 *               maintenance_mode: { type: boolean }
 *     responses:
 *       200:
 *         description: General settings updated
 */
router.patch("/configs/general", authorize("settings:general"), adminController.updateGeneralSettings);

/**
 * @swagger
 * /api/admin/drivers:
 *   get:
 *     summary: Get all drivers (paginated, searchable)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of drivers
 */
router.get("/drivers", authorize("driver:view"), adminController.getDriversList);

/**
 * @swagger
 * /api/admin/drivers/{id}:
 *   get:
 *     summary: Get driver detail by ID
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Driver details
 */
router.get("/drivers/:id", authorize("driver:view"), adminController.getDriverDetails);

/**
 * @swagger
 * /api/admin/analytics:
 *   get:
 *     summary: Get platform analytics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Platform analytics
 */
router.get("/analytics", authorize("analytics:view"), adminController.getStats);

/**
 * @swagger
 * /api/admin/users/{id}/status:
 *   put:
 *     summary: Activate or deactivate a user
 *     tags: [Admin]
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
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: User status updated
 */
router.put("/users/:id/status", authorize("user:update"), adminController.updateUserStatus);

/**
 * @swagger
 * /api/admin/users/{id}/verify:
 *   put:
 *     summary: Manually verify a user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User verified
 */
router.put("/users/:id/verify", authorize("user:update"), adminController.verifyUser);

/**
 * @swagger
 * /api/admin/users/{id}/kyc:
 *   put:
 *     summary: Update KYC level for a user
 *     tags: [Admin]
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
 *               kycLevel: { type: string, enum: [basic, full] }
 *     responses:
 *       200:
 *         description: KYC level updated
 */
router.put("/users/:id/kyc", authorize("user:update"), adminController.updateKYC);

/**
 * @swagger
 * /api/admin/agents:
 *   get:
 *     summary: Get all agents with registration counts
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of agents with stats
 */
router.get("/agents", authorize("user:view"), adminController.getAgentsRegistrations);

/**
 * @swagger
 * /api/admin/fines/pending:
 *   get:
 *     summary: Get all pending fine requests
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of pending fines
 *       500:
 *         description: Server error
 */
router.get("/fines/pending", authorize("fines:view"), adminController.getPendingFineRequests);

/**
 * @swagger
 * /api/admin/fines/approve:
 *   post:
 *     summary: Approve or Reject a fine
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id: { type: string }
 *               status: { type: string, enum: [approved, rejected] }
 *               amount: { type: number, description: "Set or override fine amount (RWF)" }
 *     responses:
 *       200:
 *         description: Fine status updated
 */
router.post("/fines/approve", authorize("fines:update"), adminController.approveFine);

/**
 * @swagger
 * /api/admin/registrations/pending:
 *   get:
 *     summary: Get all pending user registrations (drivers, agents)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, default: "pending" }
 *     responses:
 *       200:
 *         description: List of pending registrations
 *       500:
 *         description: Server error
 */
router.get("/registrations/pending", authorize("user:view"), adminController.getPendingRegistrations);
router.get("/registrations", authorize("user:view"), adminController.getPendingRegistrations);

/**
 * @swagger
 * /api/admin/registrations/{id}:
 *   get:
 *     summary: Get full details of a specific registration by user ID
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Full registration details including User and DriverProfile
 *       404:
 *         description: User not found
 */
router.get("/registrations/:id", authorize("user:view"), adminController.getRegistrationDetails);

/**
 * @swagger
 * /api/admin/registrations/{id}/status:
 *   put:
 *     summary: Review a registration to update its status
 *     tags: [Admin]
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
 *               status: { type: string, enum: [pending, correction, approved] }
 *               remarks: { type: string }
 *     responses:
 *       200:
 *         description: Registration status updated
 */
router.put("/registrations/:id/status", authorize("user:update"), adminController.reviewRegistration);

/**
 * @swagger
 * /api/admin/paypack/transactions:
 *   get:
 *     summary: Fetch all transactions directly from Paypack
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: kind
 *         schema: { type: string }
 *         description: "CASHIN or CASHOUT"
 *       - in: query
 *         name: client
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of Paypack transactions
 *       500:
 *         description: Server error
 */
router.get("/paypack/transactions", authorize("user:view"), adminController.getPaypackTransactions);

/**
 * @swagger
 * /api/admin/paypack/events:
 *   get:
 *     summary: Fetch all transaction events from Paypack
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: client
 *         schema: { type: string }
 *       - in: query
 *         name: ref
 *         schema: { type: string }
 *       - in: query
 *         name: kind
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of Paypack events
 *       500:
 *         description: Server error
 */
router.get("/paypack/events", authorize("user:view"), adminController.getPaypackEvents);

/**
 * @swagger
 * /api/admin/paypack/sync:
 *   post:
 *     summary: Sync pending transactions with Paypack and trigger wallet updates
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ref: 
 *                 type: string
 *                 description: Optional specific transaction reference to sync. If omitted, syncs all pending transactions.
 *     responses:
 *       200:
 *         description: Sync results
 *       500:
 *         description: Server error
 */
router.post("/paypack/sync", authorize("user:update"), adminController.syncTransactionsWithPaypack);

module.exports = router;
