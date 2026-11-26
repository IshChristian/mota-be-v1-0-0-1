const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const moving = require("../services/movingService");

// MOTA HomeMove (house moving). Catalog is public so the landing page and signed-out app can show it.
const router = express.Router();

const handle = (fn, fallback) => async (req, res) => {
    try {
        res.status(req.method === "POST" && req.path === "/" ? 201 : 200).json({ data: await fn(req) });
    } catch (error) {
        if (!error.status) console.error(fallback, error);
        res.status(error.status || 500).json({ message: error.status ? error.message : fallback });
    }
};

/**
 * @swagger
 * tags:
 *   name: Moving
 *   description: MOTA HomeMove — house moving with partner trucks
 */

/**
 * @swagger
 * /api/moves/catalog:
 *   get:
 *     summary: Truck sizes with price ranges, extras and item list
 *     tags: [Moving]
 */
router.get("/catalog", handle(() => moving.catalog(), "Unable to load moving trucks"));

/**
 * @swagger
 * /api/moves/estimate:
 *   post:
 *     summary: Price range for a move (from, to, homeSize, items, truckKey, loaders, packing, assembly)
 *     tags: [Moving]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/estimate", protect, handle((req) => moving.estimate(moving.readInput(req.body, { forEstimate: true })), "Unable to estimate this move"));

/**
 * @swagger
 * /api/moves:
 *   post:
 *     summary: Book a move (truck chosen, or a free home visit requested)
 *     tags: [Moving]
 *     security: [{ bearerAuth: [] }]
 *   get:
 *     summary: My moves
 *     tags: [Moving]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/", protect, handle((req) => moving.create(req.user, req.body), "Unable to book this move"));
router.get("/", protect, handle((req) => moving.listMine(req.user), "Unable to load your moves"));
router.get("/:id", protect, handle((req) => moving.getMine(req.user, req.params.id), "Unable to load this move"));
router.post("/:id/cancel", protect, handle((req) => moving.cancelMine(req.user, req.params.id, req.body?.reason), "Unable to cancel this move"));
router.post("/:id/accept", protect, handle((req) => moving.acceptQuote(req.user, req.params.id), "Unable to accept this price"));

module.exports = router;
