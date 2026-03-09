const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Admin dashboard and platform management
 */

// All admin routes require authentication and admin role
router.use(authMiddleware, roleMiddleware("admin"));

/**
 * @swagger
 * /api/admin/drivers:
 *   get:
 *     summary: Get all drivers (paginated, searchable)
 *     tags: [Admin]
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
 *       - name: search
 *         in: query
 *         schema:
 *           type: string
 *         description: Search by name, phone, or national ID
 *     responses:
 *       200:
 *         description: Paginated list of drivers with profiles and tier info
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Server error
 */
router.get("/drivers", adminController.getDrivers);

/**
 * @swagger
 * /api/admin/drivers/{id}:
 *   get:
 *     summary: Get driver detail by ID
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver user ID
 *     responses:
 *       200:
 *         description: Detailed driver info with profile, tier, streak, and stats
 *       404:
 *         description: Driver not found
 *       500:
 *         description: Server error
 */
router.get("/drivers/:id", adminController.getDriverById);

/**
 * @swagger
 * /api/admin/analytics:
 *   get:
 *     summary: Get platform analytics
 *     description: Returns comprehensive stats including users, rides, revenue, tier distribution, payment methods, referrals, and SMS
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Platform analytics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: object
 *                   properties:
 *                     totalDrivers:
 *                       type: number
 *                     totalAgents:
 *                       type: number
 *                     verifiedDrivers:
 *                       type: number
 *                     activeDrivers:
 *                       type: number
 *                 rides:
 *                   type: object
 *                   properties:
 *                     totalRides:
 *                       type: number
 *                     ridesToday:
 *                       type: number
 *                     ridesThisMonth:
 *                       type: number
 *                 revenue:
 *                   type: object
 *                   properties:
 *                     today:
 *                       type: number
 *                     thisMonth:
 *                       type: number
 *                 tiers:
 *                   type: object
 *                   properties:
 *                     bronze:
 *                       type: number
 *                     silver:
 *                       type: number
 *                     gold:
 *                       type: number
 *                     platinum:
 *                       type: number
 *                 payments:
 *                   type: object
 *                 referrals:
 *                   type: object
 *                 sms:
 *                   type: object
 *       500:
 *         description: Server error
 */
router.get("/analytics", adminController.getAnalytics);

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Get all users (filterable by role)
 *     tags: [Admin]
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
 *       - name: role
 *         in: query
 *         schema:
 *           type: string
 *           enum: [driver, agent, admin]
 *         description: Filter by user role
 *     responses:
 *       200:
 *         description: Paginated list of users
 *       500:
 *         description: Server error
 */
router.get("/users", adminController.getAllUsers);

/**
 * @swagger
 * /api/admin/users/{id}/status:
 *   put:
 *     summary: Activate or deactivate a user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isActive
 *             properties:
 *               isActive:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: User status updated
 *       400:
 *         description: isActive is required
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.put("/users/:id/status", adminController.updateUserStatus);

/**
 * @swagger
 * /api/admin/users/{id}/verify:
 *   put:
 *     summary: Manually verify a user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User verified successfully
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.put("/users/:id/verify", adminController.verifyUser);

/**
 * @swagger
 * /api/admin/users/{id}/kyc:
 *   put:
 *     summary: Update KYC level for a user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - kycLevel
 *             properties:
 *               kycLevel:
 *                 type: string
 *                 enum: [basic, full]
 *                 example: full
 *     responses:
 *       200:
 *         description: KYC level updated
 *       400:
 *         description: Invalid KYC level
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.put("/users/:id/kyc", adminController.updateKycLevel);

/**
 * @swagger
 * /api/admin/users/{id}:
 *   delete:
 *     summary: Delete a user and all related data
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User and related data deleted
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.delete("/users/:id", adminController.deleteUser);

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
 *         description: List of agents with their registration stats
 *       500:
 *         description: Server error
 */
router.get("/agents", adminController.getAgents);

/**
 * @swagger
 * /api/admin/fines/approve:
 *   post:
 *     summary: Approve or reject a fine payment request
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *               - status
 *             properties:
 *               id:
 *                 type: string
 *                 description: Mongo ID of the Fine record
 *               status:
 *                 type: string
 *                 enum: [approved, rejected]
 *               amount:
 *                 type: number
 *                 description: Fine amount (required if approved)
 *     responses:
 *       200:
 *         description: Fine request status updated
 *       400:
 *         description: Invalid status
 *       404:
 *         description: Fine request not found
 *       500:
 *         description: Server error
 */
router.post("/fines/approve", adminController.approveFine);

module.exports = router;
