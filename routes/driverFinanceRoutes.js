const router = require("express").Router();
const { protect } = require("../middleware/authMiddleware");
const controller = require("../controllers/driverFinanceController");

router.use(protect);
router.get("/summary", controller.summary);
router.get("/transactions", controller.transactions);

module.exports = router;
