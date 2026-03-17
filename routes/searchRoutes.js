const express = require("express");
const router = express.Router();
const searchController = require("../controllers/searchController");
const { protect, authorize } = require("../middleware/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: Search
 *   description: Universal search across the platform
 */

router.use(protect);

/**
 * @swagger
 * /api/search:
 *   get:
 *     summary: Universal search (drivers, rides, transactions)
 *     tags: [Search]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Search results
 */
router.get("/", authorize("search:universal"), searchController.getUniversalSearch);

/**
 * @swagger
 * /api/search/users:
 *   get:
 *     summary: Search specifically for users
 *     tags: [Search]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User results
 */
router.get("/users", authorize("user:view"), searchController.searchUsers);

module.exports = router;
