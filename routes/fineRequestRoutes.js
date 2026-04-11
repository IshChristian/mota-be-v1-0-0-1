const express = require("express");
const router = express.Router();
const fineRequestController = require("../controllers/fineRequestController");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

/**
 * @swagger
 * tags:
 *   name: Fine Requests
 *   description: Fine request and approval workflow
 */

/**
 * @swagger
 * /api/fine-requests:
 *   post:
 *     summary: Submit a fine request for admin approval
 *     description: |
 *       Drivers submit fines they need to pay. The request goes into a pending state
 *       and waits for admin review. Upon approval, the actual Fine record is created
 *       with interest calculation.
 *     tags: [Fine Requests]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fineId
 *               - amount
 *             properties:
 *               fineId:
 *                 type: string
 *                 description: External fine reference ID
 *                 example: "FINE-2024-001234"
 *               amount:
 *                 type: number
 *                 description: Fine amount in RWF
 *                 example: 10000
 *               reason:
 *                 type: string
 *                 description: Reason or context for the fine
 *                 example: "Traffic violation on KN 1 Road"
 *               attachments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     url:
 *                       type: string
 *                     description:
 *                       type: string
 *     responses:
 *       201:
 *         description: Fine request submitted, waiting for approval
 *       400:
 *         description: Missing data or active request already exists
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post(
    "/",
    authMiddleware,
    roleMiddleware("driver"),
    fineRequestController.createFineRequest
);

/**
 * @swagger
 * /api/fine-requests/my:
 *   get:
 *     summary: Get my fine requests (driver)
 *     tags: [Fine Requests]
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
 *     responses:
 *       200:
 *         description: Paginated list of driver's fine requests
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/my",
    authMiddleware,
    roleMiddleware("driver"),
    fineRequestController.getMyFineRequests
);

/**
 * @swagger
 * /api/fine-requests/all:
 *   get:
 *     summary: Get all fine requests (admin)
 *     tags: [Fine Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [pending, under_review, approved, rejected]
 *       - name: driverId
 *         in: query
 *         schema:
 *           type: string
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
 *     responses:
 *       200:
 *         description: Paginated list of all fine requests
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not authorized
 */
router.get(
    "/all",
    authMiddleware,
    roleMiddleware("admin", "manager"),
    fineRequestController.getAllFineRequests
);

/**
 * @swagger
 * /api/fine-requests/{id}:
 *   get:
 *     summary: Get a specific fine request by ID
 *     tags: [Fine Requests]
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
 *         description: Fine request details
 *       404:
 *         description: Not found
 */
router.get(
    "/:id",
    authMiddleware,
    fineRequestController.getFineRequestById
);

/**
 * @swagger
 * /api/fine-requests/{id}/approve:
 *   put:
 *     summary: Approve a fine request (admin)
 *     description: |
 *       Admin approves the fine request, which creates the actual Fine record with
 *       interest calculation from system settings.
 *     tags: [Fine Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount:
 *                 type: number
 *                 description: Override fine amount (optional)
 *               notes:
 *                 type: string
 *                 description: Admin review notes
 *     responses:
 *       200:
 *         description: Fine request approved
 *       400:
 *         description: Cannot approve or not found
 *       403:
 *         description: Not authorized
 */
router.put(
    "/:id/approve",
    authMiddleware,
    roleMiddleware("admin", "manager"),
    fineRequestController.approveFineRequest
);

/**
 * @swagger
 * /api/fine-requests/{id}/reject:
 *   put:
 *     summary: Reject a fine request (admin)
 *     tags: [Fine Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Rejection reason
 *     responses:
 *       200:
 *         description: Fine request rejected
 *       400:
 *         description: Cannot reject or not found
 *       403:
 *         description: Not authorized
 */
router.put(
    "/:id/reject",
    authMiddleware,
    roleMiddleware("admin", "manager"),
    fineRequestController.rejectFineRequest
);

/**
 * @swagger
 * /api/fine-requests/{id}/review:
 *   put:
 *     summary: Mark a fine request as under review (admin)
 *     tags: [Fine Requests]
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
 *         description: Fine request set to under review
 */
router.put(
    "/:id/review",
    authMiddleware,
    roleMiddleware("admin", "manager"),
    fineRequestController.markUnderReview
);

module.exports = router;
