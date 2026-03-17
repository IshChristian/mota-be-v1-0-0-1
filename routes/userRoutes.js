const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const uploadService = require("../services/uploadService");
const { protect } = require("../middleware/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User profile and account management
 */

router.use(protect);

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get current authenticated user profile
 *     tags: [Users]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: User profile data
 */
router.get("/me", userController.getMe);

/**
 * @swagger
 * /api/users/me:
 *   put:
 *     summary: Update current user profile
 *     tags: [Users]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               email: { type: string }
 *     responses:
 *       200:
 *         description: Profile updated
 */
router.put("/me", userController.updateMe);

/**
 * @swagger
 * /api/users/avatar:
 *   post:
 *     summary: Upload and set user profile avatar
 *     tags: [Users]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               avatar: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Avatar uploaded successfully
 */
router.post("/avatar", uploadService.uploadMiddleware.single("avatar"), userController.uploadAvatar);

router.delete("/account", userController.deleteAccount);

// Admin / elevated operation
router.patch("/:id/role", userController.assignRole);

module.exports = router;
