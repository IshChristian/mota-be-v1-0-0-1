const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { generateToken, generateOTPToken } = require("../utils/jwt");
const { sendSMS } = require("../services/smsService");
const Referral = require("../models/Referral");
const crypto = require("crypto");

/**
 * Register a new user
 * POST /api/auth/register
 */
const register = async (req, res) => {
    try {
        const { firstName, lastName, phone, nationalId, role, referralCode } = req.body;

        if (!firstName || !lastName || !phone || !nationalId) {
            return res.status(400).json({ message: "firstName, lastName, phone, and nationalId are required" });
        }

        // Check for existing user
        const existingUser = await User.findOne({
            $or: [{ phone }, { nationalId }],
        });
        if (existingUser) {
            return res.status(400).json({ message: "User with this phone number or national ID already exists" });
        }

        // Generate unique referral code for this user
        const userReferralCode = `MOTA-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

        const newUser = new User({
            firstName,
            lastName,
            phone,
            nationalId,
            role: role || "driver",
            referralCode: userReferralCode,
        });

        const savedUser = await newUser.save();

        // Handle referral if referralCode was provided
        if (referralCode) {
            const referrer = await User.findOne({ referralCode });
            if (referrer) {
                await Referral.create({
                    referrerId: referrer._id,
                    referredUserId: savedUser._id,
                    reward: 500,
                    status: "pending",
                });

                await sendSMS(
                    referrer.phone,
                    `${firstName} ${lastName} just signed up using your referral code! You'll receive your reward once they complete verification.`,
                    "referral_reward"
                );
            }
        }

        // Generate OTP and send via SMS
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpToken = generateOTPToken(savedUser._id, otp);

        savedUser.otpToken = otpToken;
        savedUser.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
        await savedUser.save();

        await sendSMS(
            phone,
            `Welcome to MOTA, ${firstName}! Your verification code is: ${otp}. Valid for 5 minutes.`,
            "registration"
        );

        res.status(201).json({
            message: "User registered successfully. OTP sent via SMS.",
            userId: savedUser._id,
            referralCode: userReferralCode,
        });
    } catch (error) {
        console.error("Register Error:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Verify OTP
 * POST /api/auth/verify-otp
 */
const verifyOTP = async (req, res) => {
    try {
        const { userId, otp } = req.body;

        if (!userId || !otp) {
            return res.status(400).json({ message: "userId and otp are required" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        if (!user.otpToken) {
            return res.status(400).json({ message: "No OTP request found. Request a new one." });
        }

        try {
            const decoded = jwt.verify(user.otpToken, process.env.JWT_SECRET);
            if (decoded.otp !== otp) {
                return res.status(400).json({ message: "Invalid OTP" });
            }

            user.isVerified = true;
            user.otpToken = null;
            user.otpExpiry = null;
            await user.save();

            // Complete referral if exists
            const referral = await Referral.findOne({ referredUserId: user._id, status: "pending" });
            if (referral) {
                referral.status = "completed";
                await referral.save();

                const referrer = await User.findById(referral.referrerId);
                if (referrer) {
                    await sendSMS(
                        referrer.phone,
                        `Your referral reward of ${referral.reward} RWF has been credited! ${user.firstName} ${user.lastName} has been verified.`,
                        "referral_reward"
                    );
                }
            }

            res.status(200).json({ message: "Phone number verified successfully" });
        } catch (tokenError) {
            return res.status(400).json({ message: "OTP expired. Request a new one." });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Create password for user
 * POST /api/auth/create-password
 */
const createPassword = async (req, res) => {
    try {
        const { userId, password } = req.body;

        if (!userId || !password) {
            return res.status(400).json({ message: "userId and password are required" });
        }

        if (password.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        user.password = hashedPassword;
        await user.save();

        res.status(200).json({ message: "Password created successfully" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Login user
 * POST /api/auth/login
 */
const login = async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.status(400).json({ message: "Phone and password are required" });
        }

        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        if (!user.password) {
            return res.status(400).json({ message: "Password not set. Please create a password first." });
        }

        if (!user.isActive) {
            return res.status(403).json({ message: "Account is deactivated. Contact admin." });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: "Invalid password" });
        }

        const token = generateToken(user);

        res.status(200).json({
            message: "Login successful",
            token,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone,
                role: user.role,
                isVerified: user.isVerified,
                kycLevel: user.kycLevel,
            },
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Resend OTP
 * POST /api/auth/resend-otp
 */
const resendOTP = async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ message: "userId is required" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpToken = generateOTPToken(user._id, otp);

        user.otpToken = otpToken;
        user.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
        await user.save();

        await sendSMS(
            user.phone,
            `Your MOTA verification code is: ${otp}. Valid for 5 minutes.`,
            "otp"
        );

        res.status(200).json({ message: "OTP sent successfully" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    register,
    verifyOTP,
    createPassword,
    login,
    resendOTP,
};
