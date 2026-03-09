const mongoose = require("mongoose");

const referralSchema = new mongoose.Schema({
    referrerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    referredUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    reward: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ["pending", "completed"],
        default: "pending",
    },
    createdAt: { type: Date, default: Date.now },
});

referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredUserId: 1 });

const Referral = mongoose.model("Referral", referralSchema);

module.exports = Referral;
