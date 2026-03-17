const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

// Public routes
/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and account management
 */

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user (Driver, Agent, or Client)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName, phone, nationalId]
 *             properties:
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               phone: { type: string, example: "+250700000000" }
 *               email: { type: string }
 *               nationalId: { type: string }
 *               role: { type: string, enum: [driver, agent, user], default: user }
 *               password: { type: string }
 *               referralCode: { type: string }
 *     responses:
 *       201:
 *         description: User registered. MoMo payment initiated if driver or agent.
 */
router.post("/register", authController.register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login with phone number or email
 *     description: Use a single identifier field that accepts either a phone number or email address
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identifier, password]
 *             properties:
 *               identifier:
 *                 type: string
 *                 description: "Phone number or email address"
 *                 example: "+250788123456"
 *               password:
 *                 type: string
 *                 example: "mypassword123"
 *     responses:
 *       200:
 *         description: Login successful, returns JWT
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Account disabled
 */
router.post("/login", authController.login);

/**
 * @swagger
 * /api/auth/verify-otp:
 *   post:
 *     summary: Verify phone via OTP
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId: { type: string }
 *               otp: { type: string }
 *     responses:
 *       200:
 *         description: Phone verified
 */
router.post("/verify-otp", authController.verifyOTP);

router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);

/**
 * @swagger
 * /api/auth/verify-email:
 *   get:
 *     summary: Verify email address via link
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Email verified
 */
router.get("/verify-email", authController.verifyEmail);
router.post("/verify-email", authController.verifyEmail);

/**
 * @swagger
 * /api/auth/2fa/verify:
 *   post:
 *     summary: Verify 2FA code during login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId: { type: string }
 *               token: { type: string }
 *     responses:
 *       200:
 *         description: 2FA verified, returns JWT
 */
router.post("/2fa/verify", authController.verify2FA);

// Protected routes
router.use(protect);

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout (invalidate session)
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Logged out
 */
router.post("/logout", authController.logout);

router.post("/refresh-token", authController.refreshToken);

/**
 * @swagger
 * /api/auth/2fa/setup:
 *   post:
 *     summary: Initiate 2FA setup (returns QR code)
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 2FA secret and QR code generated
 */
router.post("/2fa/setup", protect, authController.setup2FA);

/**
 * @swagger
 * /api/auth/registration-status:
 *   post:
 *     summary: Check activation status after paying registration fee
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId: { type: string }
 *     responses:
 *       200:
 *         description: Returns account status (active/inactive)
 */
router.post("/registration-status", authController.checkRegistrationPayment);

module.exports = router;
