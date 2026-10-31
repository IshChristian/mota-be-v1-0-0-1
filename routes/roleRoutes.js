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
router.get("/", authorize("role:view"), roleController.getRoles);

// Permission catalog for the role editor: every permission, grouped by area,
// plus which ones the current staff member may grant (only those they hold).
router.get("/permissions", authorize("role:view"), (req, res) => {
    const { PERMISSIONS } = require("../constants/staffRoles");
    const access = require("../services/accessService");
    const all = [...new Set([...PERMISSIONS, ...access.REPORT_SCOPES])];
    const groups = {};
    for (const p of all) (groups[p.split(":")[0]] ||= []).push(p);
    const mine = access.effectivePermissions(req.user);
    res.json({ data: { permissions: all, groups, grantable: req.user.role === "superadmin" ? all : all.filter((p) => mine.includes(p)) } });
});

// Roles the current staff member may assign: built-in staff roles and custom roles
// whose permissions they fully hold (superadmin can assign anything except superadmin).
router.get("/assignable", authorize("user:assign_role"), async (req, res) => {
    const { STAFF_ROLE_TEMPLATES } = require("../constants/staffRoles");
    const access = require("../services/accessService");
    const Role = require("../models/Role");
    const mine = access.effectivePermissions(req.user);
    const allowed = (perms) => req.user.role === "superadmin" || perms.every((p) => mine.includes(p));
    const builtIn = Object.entries(STAFF_ROLE_TEMPLATES).filter(([name]) => name !== "superadmin")
        .map(([name, permissions]) => ({ _id: name, name, accountType: name, permissions, builtIn: true }));
    const custom = (await Role.find().lean()).map((r) => ({ _id: String(r._id), name: r.name, accountType: STAFF_ROLE_TEMPLATES[r.name] ? r.name : "admin", permissions: r.permissions || [], builtIn: false }));
    const people = [{ _id: "driver", name: "driver", accountType: "driver", permissions: [], builtIn: true }, { _id: "client", name: "client", accountType: "client", permissions: [], builtIn: true }];
    res.json({ data: [...people, ...builtIn, ...custom].filter((r) => allowed(r.permissions)) });
});

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
