const express = require("express");
const router = express.Router();
const sseService = require("../services/sseService");
const { protect: authMiddleware } = require("../middleware/authMiddleware");

/**
 * @swagger
 * /api/realtime/driver-events:
 *   get:
 *     summary: Subscribe to real-time driver events (SSE)
 *     description: Server-Sent Events channel for drivers to receive instant ride requests and updates. Must send Bearer token in query string or header.
 *     tags: [Realtime]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: SSE stream connected
 */
router.get("/driver-events", authMiddleware, (req, res) => {
    // Add this client to the SSE manager
    sseService.addClient(req.user.id, res);
});

module.exports = router;
