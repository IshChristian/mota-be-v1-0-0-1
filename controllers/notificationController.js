const notificationService = require("../services/notificationService");

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
    getNotifications,
    getUnreadNotifications,
    markAsRead,
    deleteNotification,
};
