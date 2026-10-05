const express = require("express");
const controller = require("../controllers/fuelVoucherController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(protect);
const requireStaff = (req, res, next) => {
  if (
    !Object.hasOwn(
      require("../constants/staffRoles").STAFF_ROLE_TEMPLATES,
      req.user.role,
    )
  )
    return res
      .status(403)
      .json({
        message: "Only authorized MOTA staff can redeem fuel vouchers.",
      });
  next();
};
router.post("/claim-momo", controller.claimMoMo);
router.post("/claim-qr", controller.claimQR);
router.post(
  "/redeem-code",
  requireStaff,
  authorize("fuel_voucher:manage"),
  controller.redeemCode,
);
router.get("/daily-status", controller.dailyStatus);
router.get("/history", controller.history);
router.get("/weekly-savings", controller.weeklySavings);
router.get("/stations", controller.stations);
router.get("/:id", controller.details);
router.patch(
  "/:userId/:id/redeem",
  requireStaff,
  authorize("fuel_voucher:manage"),
  controller.redeem,
);
router.patch("/:id/redeem", (req, res) =>
  res.status(403).json({
    message:
      "A MOTA fuel attendant must confirm redemption. Show your voucher code at an approved station.",
  }),
);
module.exports = router;
