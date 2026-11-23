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
    // Fail well inside the app's 30 s request timeout (nodemailer waits 2 minutes by default).
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000,
    dnsTimeout: 5000,
});

const fromAddress = () => process.env.SMTP_FROM_EMAIL || "no-reply@mota.rw";

/** Brevo's HTTPS API, for hosts that block SMTP ports (Render's free web services do). */
const sendViaBrevo = async (to, subject, text, html) => {
    const from = fromAddress().match(/^\s*"?(.*?)"?\s*<(.+)>\s*$/);
    const sender = from ? { name: from[1] || "MOTA", email: from[2] } : { name: "MOTA", email: fromAddress() };
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sender, to: [{ email: to }], subject, ...(html ? { htmlContent: html } : { textContent: text }) }),
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Brevo refused the email (${response.status}): ${await response.text()}`);
};

/**
 * Send an email over Brevo when BREVO_API_KEY is set, otherwise SMTP.
 * Never throws: returns false when it was not sent.
 */
const sendEmail = async (to, subject, text, html) => {
    try {
        if (process.env.BREVO_API_KEY) {
            await sendViaBrevo(to, subject, text, html);
            return true;
        }
        await transporter.sendMail({
            from: fromAddress(),
            to,
            subject,
            text,
            html,
        });
        return true;
    } catch (error) {
        console.error("Email not sent:", error.code || "", error.message);
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

// Ride-critical events go out on the high-priority "rides" Android channel.
const URGENT_EVENTS = new Set(["rideRequest", "rideAccepted", "driverApproaching", "driverArrived", "rideStartRequested", "rideStopRequested", "rideCancelled", "rideExpired", "rideAssigned", "counterOffer", "chatMessage", "paymentUpdate", "safetyAlert"]);

const RIDE_REQUEST_SOUND = "mota_ride_request.wav"; // bundled in the app (assets/sounds)

const sendPushNotification = async (userId, title, body, data = {}) => {
    const user = await User.findById(userId).select("+pushTokens");
    const tokens = (user?.pushTokens || []).map((item) => item.token);
    if (!tokens.length) return { sent: 0 };

    const urgent = URGENT_EVENTS.has(data.event);
    // New ride requests ring with MOTA's own sound and long vibration (app channel "ride_requests")
    // and expire after 2 minutes: a phone that was offline must not ring for an offer that's gone.
    const rideRequest = data.event === "rideRequest";
    const messages = tokens.map((to) => ({
        to,
        sound: rideRequest ? RIDE_REQUEST_SOUND : "default",
        channelId: rideRequest ? "ride_requests" : urgent ? "rides" : "default",
        priority: urgent ? "high" : "default",
        ...(rideRequest ? { ttl: 120 } : {}),
        title,
        body,
        data,
    }));
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
    });
    if (!response.ok) throw new Error(`Expo push request failed (${response.status})`);
    const result = await response.json();
    // Drop tokens Expo says are dead (app uninstalled / logged out elsewhere) so they stop failing.
    const dead = (result?.data || []).map((ticket, i) => (ticket?.details?.error === "DeviceNotRegistered" ? tokens[i] : null)).filter(Boolean);
    if (dead.length) await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token: { $in: dead } } } }).catch(() => {});
    return { sent: tokens.length - dead.length, removed: dead.length, response: result };
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
        { returnDocument: "after" }
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
