const express = require("express");
const router = express.Router();
const settingController = require("../controllers/settingController");
const { protect } = require("../middleware/authMiddleware");

router.use(protect);

router.get("/", settingController.getSettings);
router.put("/", settingController.updateSettings);
router.patch("/notifications", settingController.updateNotifications);
router.patch("/privacy", settingController.updatePrivacy);
router.patch("/security", settingController.updateSecurity);
router.patch("/preferences", settingController.updatePreferences);

module.exports = router;
