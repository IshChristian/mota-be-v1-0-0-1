const express = require("express");
const controller = require("../controllers/fuelVoucherController");
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
module.exports = router;
