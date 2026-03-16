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
 *     responses:
 *       200:
 *         description: Fine status updated
 */
router.post("/fines/approve", authorize("fines:update"), adminController.approveFine);

module.exports = router;
