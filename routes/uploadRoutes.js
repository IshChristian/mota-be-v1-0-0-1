const express = require("express");
const router = express.Router();
const { rateLimit } = require("express-rate-limit");
const { createUploadSignature } = require("../controllers/uploadSignatureController");
const uploadController = require("../controllers/uploadController");
const uploadService = require("../services/uploadService");
const { protectOnboarding } = require("../middleware/authMiddleware");

// Require authentication for all upload routes
router.use(protectOnboarding);

// Authenticated onboarding accounts may upload their first identity documents.
router.post("/signature", rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { message: "Too many upload requests. Please wait and retry." } }), createUploadSignature);

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
