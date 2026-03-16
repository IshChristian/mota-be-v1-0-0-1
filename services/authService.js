const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const User = require("../models/User");
const { sendEmail } = require("../services/notificationService");

const generateToken = (user) => {
    return jwt.sign(
        { id: user._id, role: user.role, phone: user.phone },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );
};

const sendVerificationEmail = async (user) => {
    if (!user.email) return false;

    // Create token
    const token = jwt.sign({ id: user._id, action: "verify_email" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/api/auth/verify-email?token=${token}`;

    const html = `
        <h2>Welcome to MOTA</h2>
        <p>Hi ${user.firstName},</p>
        <p>Please verify your email clicking the link below:</p>
        <a href="${verifyUrl}" style="padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Verify Email</a>
    `;

    return await sendEmail(user.email, "Verify Your MOTA Account", "Verify your email", html);
};

const sendPasswordResetEmail = async (user) => {
    if (!user.email) return false;

    const token = jwt.sign({ id: user._id, action: "reset_password" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/api/auth/reset-password?token=${token}`;

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
