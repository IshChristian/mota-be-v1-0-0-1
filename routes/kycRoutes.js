const router = require("express").Router();
const { protectOnboarding } = require("../middleware/authMiddleware");
const controller = require("../controllers/kycController");

router.use(protectOnboarding);
router.get("/me", controller.getMine);
router.put("/me", controller.submitMine);

module.exports = router;
