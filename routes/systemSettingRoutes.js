const express = require("express");
const router = express.Router();
const systemSettingController = require("../controllers/systemSettingController");
const { protect, authorize } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

// All system settings routes require auth + admin/manager role
router.use(protect);
router.use(roleMiddleware("admin", "manager"));

/**
 * @swagger
 * tags:
 *   name: System Settings
 *   description: Platform system configuration (admin only)
 */

/**
 * @swagger
 * /api/system-settings:
 *   get:
 *     summary: Get all system settings
 *     tags: [System Settings]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: category
 *         in: query
 *         schema:
 *           type: string
 *           enum: [financial, general, loan, notification]
 *     responses:
 *       200:
 *         description: List of system settings
 */
router.get("/", systemSettingController.getAllSettings);

/**
 * @swagger
 * /api/system-settings/seed:
 *   post:
 *     summary: Seed default system settings
 *     tags: [System Settings]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Defaults seeded
 */
router.post("/seed", systemSettingController.seedDefaults);

/**
 * @swagger
 * /api/system-settings:
 *   put:
 *     summary: Bulk update multiple settings
 *     tags: [System Settings]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               settings:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     key: { type: string }
 *                     value: {}
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put("/", systemSettingController.bulkUpdateSettings);

/**
 * @swagger
 * /api/system-settings/category/{category}:
 *   get:
 *     summary: Get settings by category
 *     tags: [System Settings]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: category
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           enum: [financial, general, loan, notification]
 *     responses:
 *       200:
 *         description: Settings for the category
 */
router.get("/category/:category", systemSettingController.getSettingsByCategory);

/**
 * @swagger
 * /api/system-settings/{key}:
 *   put:
 *     summary: Update a single system setting
 *     tags: [System Settings]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: key
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [value]
 *             properties:
 *               value: {}
 *     responses:
 *       200:
 *         description: Setting updated
 */
router.put("/:key", systemSettingController.updateSetting);

module.exports = router;
