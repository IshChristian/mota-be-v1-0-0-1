const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notificationController");
const {
  protect,
  protectOnboardingStatus,
} = require("../middleware/authMiddleware");

// Own inbox remains available during account verification or deactivation.
router.get(
  "/",
  protectOnboardingStatus,
  notificationController.getNotifications,
);
router.get(
  "/unread",
  protectOnboardingStatus,
  notificationController.getUnreadNotifications,
);
router.patch(
  "/:id/read",
  protectOnboardingStatus,
  notificationController.markAsRead,
);

router.post("/push-token", protect, notificationController.registerPushToken);
router.delete(
  "/push-token",
  protect,
  notificationController.unregisterPushToken,
);

/**
 * @swagger
 * /api/notifications:
 *   get:
 *     summary: Get user notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of notifications
 */

/**
 * @swagger
 * /api/notifications/unread:
 *   get:
 *     summary: Get unread user notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of unread notifications
 */

/**
 * @swagger
 * /api/notifications/{id}/read:
 *   patch:
 *     summary: Mark a notification as read
 *     tags: [Notifications]
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
 *         description: Notification marked as read
 */

/**
 * @swagger
 * /api/notifications/{id}:
 *   delete:
 *     summary: Delete a notification
 *     tags: [Notifications]
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
 *         description: Notification deleted
 */

router.delete(
  "/:id",
  protectOnboardingStatus,
  notificationController.deleteNotification,
);

module.exports = router;
