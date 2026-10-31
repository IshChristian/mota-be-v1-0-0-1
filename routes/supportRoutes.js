// /api/support — help-center requests for passengers and drivers.
const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const support = require("../services/supportService");

const router = express.Router();
router.use(protect);
const wrap = (fn, status = 200) => async (req, res) => {
    try { res.status(status).json({ data: await fn(req) }); }
    catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : "Support is unavailable right now." }); }
};

router.get("/", async (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        res.json(await support.listMine(req.user._id, page, limit));
    } catch (e) { res.status(500).json({ message: "Support is unavailable right now." }); }
});
router.post("/", wrap((req) => support.create(req.user, req.body || {}), 201));
router.get("/:id", wrap((req) => support.getMine(req.user._id, req.params.id)));
router.post("/:id/messages", wrap((req) => support.customerReply(req.user, req.params.id, req.body?.text)));
router.post("/:id/reopen", wrap((req) => support.customerReply(req.user, req.params.id, req.body?.text, { reopen: true })));

module.exports = router;
