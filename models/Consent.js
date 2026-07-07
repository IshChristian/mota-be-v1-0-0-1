const mongoose = require("mongoose");

const consentSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    consentType: {
        type: String,
        enum: ["data_processing", "lending_terms", "savings_terms", "sms_notifications", "credit_check"],
        required: true,
    },
    version: { type: String, default: "v1.0" },
    consentedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date },
    ipAddress: { type: String, trim: true },
    channel: {
        type: String,
        enum: ["app", "ussd", "sms"],
        default: "app",
    },
});

consentSchema.index({ driverId: 1, consentType: 1 });

const Consent = mongoose.model("Consent", consentSchema);

module.exports = Consent;
