const Setting = require("../models/Setting"); // UserSetting model

const getSettingsByUserId = async (userId) => {
    let settings = await Setting.findOne({ userId });
    if (!settings) {
        settings = await Setting.create({ userId });
    }
    return settings;
};

const updateSettings = async (userId, updateData) => {
    return await Setting.findOneAndUpdate({ userId }, updateData, { new: true, upsert: true });
};

const updateCategory = async (userId, category, data) => {
    const updateObj = {};
    for (const key in data) {
        updateObj[`${category}.${key}`] = data[key];
    }
    return await Setting.findOneAndUpdate({ userId }, { $set: updateObj }, { new: true, upsert: true });
};

module.exports = {
    getSettingsByUserId,
    updateSettings,
    updateCategory,
};
