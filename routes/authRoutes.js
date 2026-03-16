const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

// Public routes
router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/verify-otp", authController.verifyOTP);
router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);

// Email verification links are typically GET but prompt asked for POST, 
// keeping GET as link clicks are GETs, but providing POST alias to match prompt
router.get("/verify-email", authController.verifyEmail);
router.post("/verify-email", authController.verifyEmail);

// 2FA external verify step (if not logged in but requires 2FA)
router.post("/2fa/verify", authController.verify2FA);

// Protected routes
router.use(protect);
router.post("/logout", authController.logout);
router.post("/refresh-token", authController.refreshToken);
router.post("/2fa/setup", protect, authController.setup2FA);
router.post("/registration-status", authController.checkRegistrationPayment);

module.exports = router;
