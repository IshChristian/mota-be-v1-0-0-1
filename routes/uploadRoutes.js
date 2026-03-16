const express = require("express");
const router = express.Router();
const uploadController = require("../controllers/uploadController");
const uploadService = require("../services/uploadService");
const { protect } = require("../middleware/authMiddleware");

// Require authentication for all upload routes
router.use(protect);

/**
 * @swagger
 * /api/uploads:
 *   post:
 *     summary: Upload a new file
 *     tags: [Uploads]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: File uploaded successfully
 */
router.post("/", uploadService.uploadMiddleware.single("file"), uploadController.uploadFile);

/**
 * @swagger
 * /api/uploads/{id}:
 *   get:
 *     summary: Get upload metadata by ID
 *     tags: [Uploads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Upload metadata
 */
router.get("/:id", uploadController.getUpload);

/**
 * @swagger
 * /api/uploads/{id}:
 *   delete:
 *     summary: Delete an uploaded file
 *     tags: [Uploads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File deleted successfully
 */
router.delete("/:id", uploadController.deleteUpload);

module.exports = router;
