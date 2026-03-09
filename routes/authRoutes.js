const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

/**
 * @swagger
 * tags:
 *   name: Authentication
 *   description: User authentication and registration
 */

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *               - lastName
 *               - phone
 *               - nationalId
 *             properties:
 *               firstName:
 *                 type: string
 *                 description: User first name
 *                 example: Jean
 *               lastName:
 *                 type: string
 *                 description: User last name
 *                 example: Habimana
 *               phone:
 *                 type: string
 *                 description: Phone number (Rwanda format)
 *                 example: "+250788123456"
 *               nationalId:
 *                 type: string
 *                 description: National ID number
 *                 example: "1199880012345678"
 *               role:
 *                 type: string
 *                 enum: [driver, agent, admin]
 *                 description: User role (defaults to driver)
 *                 example: driver
 *               referralCode:
 *                 type: string
 *                 description: Referral code from existing user
 *                 example: "MOTA-A1B2C3"
 *     responses:
 *       201:
 *         description: User registered successfully, OTP sent via SMS
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 referralCode:
 *                   type: string
 *       400:
 *         description: Missing fields or user already exists
 *       500:
 *         description: Server error
 */
router.post("/register", authController.register);

/**
 * @swagger
 * /api/auth/verify-otp:
 *   post:
 *     summary: Verify OTP code sent via SMS
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - otp
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User ID returned from registration
 *                 example: "64a1b2c3d4e5f6a7b8c9d0e1"
 *               otp:
 *                 type: string
 *                 description: 6-digit OTP code
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Phone number verified successfully
 *       400:
 *         description: Invalid or expired OTP
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post("/verify-otp", authController.verifyOTP);

/**
 * @swagger
 * /api/auth/create-password:
 *   post:
 *     summary: Create password for user account
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - password
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User ID
 *                 example: "64a1b2c3d4e5f6a7b8c9d0e1"
 *               password:
 *                 type: string
 *                 description: Password (minimum 6 characters)
 *                 example: "securepassword123"
 *     responses:
 *       200:
 *         description: Password created successfully
 *       400:
 *         description: Missing fields or password too short
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post("/create-password", authController.createPassword);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login with phone and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - password
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Phone number
 *                 example: "+250788123456"
 *               password:
 *                 type: string
 *                 description: User password
 *                 example: "securepassword123"
 *     responses:
 *       200:
 *         description: Login successful, returns JWT token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                     phone:
 *                       type: string
 *                     role:
 *                       type: string
 *                     isVerified:
 *                       type: boolean
 *                     kycLevel:
 *                       type: string
 *       400:
 *         description: Missing fields
 *       401:
 *         description: Invalid password
 *       403:
 *         description: Account deactivated
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post("/login", authController.login);

/**
 * @swagger
 * /api/auth/resend-otp:
 *   post:
 *     summary: Resend OTP verification code
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User ID
 *                 example: "64a1b2c3d4e5f6a7b8c9d0e1"
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post("/resend-otp", authController.resendOTP);

module.exports = router;
