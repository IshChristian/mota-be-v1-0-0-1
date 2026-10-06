const express = require("express");
const router = express.Router();
const roleController = require("../controllers/roleController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Require authentication for roles
router.use(protect);

/**
 * @swagger
 * /api/roles:
 *   get:
 *     summary: Get all roles
 *     tags: [Roles & Permissions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of roles
 */
/**
 * @swagger
 * /api/roles/permissions:
 *   get:
 *     summary: List the authoritative permission catalog and grantable permissions
 *     tags: [Roles & Permissions]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Permissions grouped by system domain }
 * /api/roles/assignable:
 *   get:
 *     summary: List roles assignable by the authenticated user creator or role assigner
 *     tags: [Roles & Permissions]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Assignable roles with supported account types }
 */
router.get("/permissions", authorize("role:view"), roleController.permissionCatalog);
router.get("/assignable", roleController.assignableRoles);
router.get("/", authorize("role:view"), roleController.getRoles);

/**
 * @swagger
 * /api/roles:
 *   post:
 *     summary: Create a new role
 *     tags: [Roles & Permissions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Role created
 */
router.post("/", authorize("role:manage"), roleController.createRole);

/**
 * @swagger
 * /api/roles/{id}:
 *   patch:
 *     summary: Update role permissions
 *     tags: [Roles & Permissions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Role updated
 */
router.patch("/:id", authorize("role:manage"), roleController.updateRole);
router.put("/:id/permissions", authorize("role:manage"), roleController.updateRole);
router.delete("/:id", authorize("role:manage"), roleController.deleteRole);

module.exports = router;
