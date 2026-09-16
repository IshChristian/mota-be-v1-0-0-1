const notificationService = require("../services/notificationService");
const User = require("../models/User");

const isExpoToken = (token) => /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token || "");

const registerPushToken = async (req, res) => {
    try {
        const { token, platform } = req.body;
        if (!isExpoToken(token) || !["android", "ios"].includes(platform)) {
            return res.status(400).json({ message: "A valid Expo push token and platform are required" });
        }
        await User.updateOne(
            { _id: req.user.id },
            { $pull: { pushTokens: { token } } }
        );
        await User.updateOne(
            { _id: req.user.id },
            { $push: { pushTokens: { token, platform, updatedAt: new Date() } } }
        );
        res.status(200).json({ message: "Push token registered" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const unregisterPushToken = async (req, res) => {
    try {
        const { token } = req.body;
        if (!isExpoToken(token)) return res.status(400).json({ message: "A valid Expo push token is required" });
        await User.updateOne({ _id: req.user.id }, { $pull: { pushTokens: { token } } });
        res.status(200).json({ message: "Push token removed" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getNotifications = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await notificationService.getUserNotifications(req.user.id, false, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getUnreadNotifications = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await notificationService.getUserNotifications(req.user.id, true, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const markAsRead = async (req, res) => {
    try {
        const notification = await notificationService.markAsRead(req.params.id, req.user.id);
        if (!notification) {
            return res.status(404).json({ message: "Notification not found" });
        }
        res.status(200).json({ message: "Marked as read", data: notification });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const deleteNotification = async (req, res) => {
    try {
        const deleted = await notificationService.deleteNotification(req.params.id, req.user.id);
        if (!deleted) {
            return res.status(404).json({ message: "Notification not found" });
        }
        res.status(200).json({ message: "Notification deleted" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    registerPushToken,
    unregisterPushToken,
    getNotifications,
    getUnreadNotifications,
    markAsRead,
    deleteNotification,
};
