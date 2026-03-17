const mongoose = require("mongoose");

const userSettingSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        profile: {
            visibility: { type: String, enum: ["public", "private"], default: "public" },
        },
        notifications: {
            emailEnabled: { type: Boolean, default: true },
            pushEnabled: { type: Boolean, default: true },
            smsEnabled: { type: Boolean, default: true },
            marketing: { type: Boolean, default: false },
        },
        privacy: {
            showLocation: { type: Boolean, default: true },
            shareData: { type: Boolean, default: false },
        },
        security: {
            loginAlerts: { type: Boolean, default: true },
        },
        preferences: {
            language: { type: String, default: "en" },
            theme: { type: String, enum: ["light", "dark", "system"], default: "system" },
        },
    },
    { timestamps: true, collection: "settings" }
);

module.exports = mongoose.model("UserSetting", userSettingSchema);

