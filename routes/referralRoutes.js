const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const referrals = require("../services/referralService");

const router = express.Router();
router.use(protect);
router.get("/me", async (req, res) => {
    try { res.json({ data: await referrals.mine(req.user, Math.max(1, Number(req.query.page) || 1)) }); }
    catch (e) { res.status(500).json({ message: "Referrals are unavailable right now." }); }
});
router.post("/check-rewards", async (req, res) => {
    try { const data = await referrals.checkMine(req.user); res.json({ message: data.message, data }); }
    catch (e) { res.status(500).json({ message: "Rewards could not be checked. Try again later." }); }
});
module.exports = router;
