const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const User = require("../models/User");
const { sendEmail } = require("../services/notificationService");

const generateToken = (user, sessionId) => {
    return jwt.sign(
        { id: user._id, role: user.role, phone: user.phone, tokenVersion: user.tokenVersion || 0, ...(sessionId ? { sid: sessionId } : {}) },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );
};

const sendVerificationEmail = async (user, otp) => {
    if (!user.email) return false;

    const html = `
        <h2>Welcome to MOTA</h2>
        <p>Hi ${user.firstName},</p>
        <p>Thank you for registering. Please use the following 6-digit code to verify your email address:</p>
        <h3 style="font-size: 24px; letter-spacing: 2px; padding: 10px; background: #f0f0f0; display: inline-block;">${otp}</h3>
        <p>This code will expire in 5 minutes.</p>
    `;

    return await sendEmail(user.email, "Verify Your MOTA Account", "Verify your email", html);
};

const sendPasswordResetEmail = async (user) => {
    if (!user.email) return false;

    const token = crypto.randomBytes(32).toString("hex");
    user.passwordResetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
    user.passwordResetExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();
    const resetUrl = `${process.env.MOBILE_DEEP_LINK || "mota://reset-password"}?token=${token}`;

    const html = `
        <h2>Reset Password</h2>
        <p>Click the link below to reset your MOTA password:</p>
        <a href="${resetUrl}">Reset Password</a>
    `;

    return await sendEmail(user.email, "Reset Password - MOTA", "Reset your password", html);
};

const setup2FA = async (userId) => {
    const secret = speakeasy.generateSecret({ name: `MOTA (${userId})` });

    const user = await User.findById(userId);
    user.twoFactorSecret = secret.base32;
    await user.save();

    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);

    return {
        secret: secret.base32,
        qrCodeUrl,
    };
};

const verify2FA = (secret, token) => {
    return speakeasy.totp.verify({
        secret,
        encoding: "base32",
        token,
        window: 1 // allow 30 seconds drift
    });
};

module.exports = {
    generateToken,
    sendVerificationEmail,
    sendPasswordResetEmail,
    setup2FA,
    verify2FA,
};
