const settingService = require("../services/settingService");

const getSettings = async (req, res) => {
    try {
        const settings = await settingService.getSettingsByUserId(req.user.id);
        res.status(200).json({ data: settings });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateSettings = async (req, res) => {
    try {
        const settings = await settingService.updateSettings(req.user.id, req.body);
        res.status(200).json({ message: "Settings updated", data: settings });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateCategorySettings = (category) => async (req, res) => {
    try {
        const data = req.body;
        const settings = await settingService.updateCategory(req.user.id, category, data);
        res.status(200).json({ message: `${category} settings updated`, data: settings });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getSettings,
    updateSettings,
    updateNotifications: updateCategorySettings("notifications"),
    updatePrivacy: updateCategorySettings("privacy"),
    updateSecurity: updateCategorySettings("security"),
    updatePreferences: updateCategorySettings("preferences"),
};
