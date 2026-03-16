const mongoose = require("mongoose");

const smsLogSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    message: { type: String, required: true },
    type: {
        type: String,
        enum: [
            "registration",
            "otp",
            "ride_confirmation",
            "tier_promotion",
            "referral_reward",
            "system_alert",
            "cash_in",
            "cash_out",
            "admin_credit",
            "fine_payment",
        ],
    },
    status: {
        type: String,
        enum: ["sent", "failed", "pending"],
        default: "pending",
    },
    sentAt: { type: Date, default: Date.now },
});

smsLogSchema.index({ phone: 1, sentAt: -1 });

const SmsLog = mongoose.model("SmsLog", smsLogSchema);

module.exports = SmsLog;
