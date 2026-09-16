const nodemailer = require("nodemailer");
const Notification = require("../models/Notification");
const User = require("../models/User");

// Create standard SMTP transporter
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === "true" || false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

/**
 * Send an email using Nodemailer
 */
const sendEmail = async (to, subject, text, html) => {
    try {
        await transporter.sendMail({
            from: process.env.SMTP_FROM_EMAIL || "no-reply@mota.rw",
            to,
            subject,
            text,
            html,
        });
        return true;
    } catch (error) {
        console.error("Nodemailer error:", error);
        return false;
    }
};

/**
 * Create In-App Notification
 */
const createNotification = async (userId, title, message, type = "in_app", metadata = {}) => {
    return await Notification.create({
        userId,
        title,
        message,
        type,
        metadata,
    });
};

const sendPushNotification = async (userId, title, body, data = {}) => {
    const user = await User.findById(userId).select("+pushTokens");
    const tokens = (user?.pushTokens || []).map((item) => item.token);
    if (!tokens.length) return { sent: 0 };

    const messages = tokens.map((to) => ({ to, sound: "default", title, body, data }));
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
    });
    if (!response.ok) throw new Error(`Expo push request failed (${response.status})`);
    return { sent: tokens.length, response: await response.json() };
};

const getUserNotifications = async (userId, unreadOnly = false, page = 1, limit = 20) => {
    const query = { userId };
    if (unreadOnly) {
        query.read = false;
    }

    const skip = (page - 1) * limit;

    const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

    const total = await Notification.countDocuments(query);

    return {
        data: notifications,
        page,
        limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit)
    };
};

const markAsRead = async (id, userId) => {
    return await Notification.findOneAndUpdate(
        { _id: id, userId },
        { read: true },
        { new: true }
    );
};

const deleteNotification = async (id, userId) => {
    return await Notification.findOneAndDelete({ _id: id, userId });
};

module.exports = {
    sendEmail,
    createNotification,
    sendPushNotification,
    getUserNotifications,
    markAsRead,
    deleteNotification,
};
