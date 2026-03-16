const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        index: true,
    },
    agentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    rideId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Ride",
    },
    amount: {
        type: Number,
        required: true,
    },
    type: {
        type: String,
        required: true,
        enum: [
            "ride_payment",
            "cash_in",
            "cash_out",
            "agent_cash_in",
            "fine_payment",
            "referral_reward",
            "admin_credit",
            "commission",
        ],
    },
    status: {
        type: String,
        enum: ["pending", "completed", "failed"],
        default: "pending",
    },
    reference: {
        type: String,     // Paypack transaction reference
        trim: true,
    },
    description: {
        type: String,
        trim: true,
    },
    paypackRef: {
        type: String,     // Paypack ref for cashout tracking
        trim: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true,
    },
});

transactionSchema.index({ driverId: 1, createdAt: -1 });

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
