const express = require("express");
const { protectOnboarding } = require("../middleware/authMiddleware");
const promoController = require("../controllers/promoController");

// Drivers paying their registration fee are still onboarding, so the onboarding session is enough.
const router = express.Router();
router.post("/preview", protectOnboarding, promoController.preview);

module.exports = router;
