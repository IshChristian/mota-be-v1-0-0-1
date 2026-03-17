const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
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
    feeAmount: {
        type: Number,
        default: 0,
    },
    type: {
        type: String,
        required: true,
        enum: [
            "ride_payment",
            "platform_commission",
            "cash_in",
            "cash_out",
            "cash_out_fee",
            "agent_cash_in",
            "fine_payment",
            "fine_loan_issued",
            "fine_loan_repayment",
            "referral_reward",
            "admin_credit",
            "commission",
            "agent_registration_fee",
            "agent_pay_fine",
            "cash_out_refund",
            "transaction_fee",
        ],
    },
    status: {
        type: String,
        enum: ["pending", "completed", "failed"],
        default: "pending",
    },
    reference: {
        type: String,
        trim: true,
    },
    description: {
        type: String,
        trim: true,
    },
    paypackRef: {
        type: String,
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

