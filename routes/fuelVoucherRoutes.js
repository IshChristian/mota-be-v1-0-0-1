const express = require("express");
const controller = require("../controllers/fuelVoucherController");
const service = require("../services/fuelVoucherService");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(protect);
router.post("/claim-momo", controller.claimMoMo);
router.post("/claim-qr", controller.claimQR);
router.get("/daily-status", controller.dailyStatus);
router.get("/history", controller.history);
router.get("/weekly-savings", controller.weeklySavings);
router.get("/stations", controller.stations);
router.patch("/:id/redeem", controller.redeem);
// Staff redemption by code (same as /api/admin/fuel-vouchers/redeem; kept for tools built on the older route).
router.post("/redeem-code", require("../middleware/authMiddleware").authorize("fuel_voucher:manage"), async (req, res) => {
    try { res.json({ data: await service.redeemByCode(req.body?.code, req.user.id, req.body?.station) }); }
    catch (error) { res.status(error.statusCode || 400).json({ message: error.message }); }
});
router.get("/:id", controller.getVoucher);

module.exports = router;
