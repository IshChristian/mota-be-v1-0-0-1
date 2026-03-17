/**
 * Backward-compatible config service.
 * Delegates to systemSettingService for all operations.
 */
const systemSettingService = require("./systemSettingService");

const getConfig = async (key, defaultValue) => {
    return await systemSettingService.getSetting(key, defaultValue);
};

const setConfig = async (key, value, description = "", userId = null) => {
    return await systemSettingService.updateSetting(key, value, userId);
};

const refreshCache = async () => {
    return await systemSettingService.refreshCache();
};

module.exports = {
    getConfig,
    setConfig,
    refreshCache,
};

