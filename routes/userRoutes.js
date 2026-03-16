const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const uploadService = require("../services/uploadService");
const { protect } = require("../middleware/authMiddleware");

router.use(protect);

router.get("/", userController.getUsers);
router.get("/me", userController.getMe);
router.get("/:id", userController.getUser);

router.put("/me", userController.updateMe);
router.delete("/account", userController.deleteAccount);
router.post("/avatar", uploadService.uploadMiddleware.single("avatar"), userController.uploadAvatar);

// Admin / elevated operation
router.patch("/:id/role", userController.assignRole);

module.exports = router;
