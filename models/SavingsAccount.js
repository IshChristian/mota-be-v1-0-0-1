const mongoose = require("mongoose");

const savingsAccountSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
        index: true,
    },
    balance: { type: Number, default: 0, min: 0 },
    totalDeposited: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    rewardAccrued: { type: Number, default: 0 },
    lastRewardDate: { type: Date },
    bankPartnerRef: { type: String, trim: true },
    status: {
        type: String,
        enum: ["active", "frozen", "closed"],
        default: "active",
    },
    deposits: [{
        amount: { type: Number, required: true },
        depositedAt: { type: Date, default: Date.now },
        source: {
            type: String,
            enum: ["wallet", "momo", "ride_earning"],
            default: "wallet",
        },
        transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
    }],
    withdrawals: [{
        amount: { type: Number, required: true },
        withdrawnAt: { type: Date, default: Date.now },
        destination: {
            type: String,
            enum: ["wallet", "momo"],
            default: "wallet",
        },
        transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

savingsAccountSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

savingsAccountSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const SavingsAccount = mongoose.model("SavingsAccount", savingsAccountSchema);

module.exports = SavingsAccount;
