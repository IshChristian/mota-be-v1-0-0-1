const SystemConfig = require("../models/SystemConfig");

// Cache implementation for performance
let configCache = {};

const getConfig = async (key, defaultValue) => {
    if (configCache[key] !== undefined) {
        return configCache[key];
    }

    const config = await SystemConfig.findOne({ key });
    if (config) {
        configCache[key] = config.value;
        return config.value;
    }

    return defaultValue;
};

const setConfig = async (key, value, description = "", userId = null) => {
    const config = await SystemConfig.findOneAndUpdate(
        { key },
        { value, description, updatedBy: userId },
        { upsert: true, new: true }
    );
    configCache[key] = value;
    return config;
};

// Clear cache (useful if multiple instances or for testing)
const refreshCache = async () => {
    const configs = await SystemConfig.find({});
    const newCache = {};
    configs.forEach(c => {
        newCache[c.key] = c.value;
    });
    configCache = newCache;
};

module.exports = {
    getConfig,
    setConfig,
    refreshCache
};
