const router = require("express").Router();
const { protect } = require("../middleware/authMiddleware");
const controller = require("../controllers/kycController");

router.use(protect);
router.get("/me", controller.getMine);
router.put("/me", controller.submitMine);

module.exports = router;
