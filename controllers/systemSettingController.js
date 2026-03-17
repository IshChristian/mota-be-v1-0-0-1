const systemSettingService = require("../services/systemSettingService");

/**
 * GET /api/system-settings
 * List all system settings (optionally filter by category)
 */
const getAllSettings = async (req, res) => {
    try {
        const { category } = req.query;
        const settings = await systemSettingService.getAllSettings(category || null);
        res.status(200).json({ data: settings });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/system-settings/:category
 * List settings by category
 */
const getSettingsByCategory = async (req, res) => {
    try {
        const { category } = req.params;
        const validCategories = ["financial", "general", "loan", "notification"];
        if (!validCategories.includes(category)) {
            return res.status(400).json({ message: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
        }
        const settings = await systemSettingService.getAllSettings(category);
        res.status(200).json({ data: settings });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * PUT /api/system-settings
 * Bulk update multiple settings
 */
const bulkUpdateSettings = async (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || !Array.isArray(settings) || settings.length === 0) {
            return res.status(400).json({ message: "settings array is required" });
        }
        // Validate each entry has key and value
        for (const s of settings) {
            if (!s.key || s.value === undefined) {
                return res.status(400).json({ message: `Each setting must have key and value. Invalid entry: ${JSON.stringify(s)}` });
            }
        }
        const results = await systemSettingService.bulkUpdate(settings, req.user.id);
        res.status(200).json({ message: `${results.length} settings updated`, data: results });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * PUT /api/system-settings/:key
 * Update a single setting by key
 */
const updateSetting = async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        if (value === undefined) {
            return res.status(400).json({ message: "value is required" });
        }
        const config = await systemSettingService.updateSetting(key, value, req.user.id);
        res.status(200).json({ message: `Setting '${key}' updated`, data: config });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/system-settings/seed
 * Seed/reset default settings
 */
const seedDefaults = async (req, res) => {
    try {
        await systemSettingService.seedDefaults();
        const settings = await systemSettingService.getAllSettings();
        res.status(200).json({ message: "Default settings seeded", data: settings });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getAllSettings,
    getSettingsByCategory,
    bulkUpdateSettings,
    updateSetting,
    seedDefaults,
};
