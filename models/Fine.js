const mongoose = require("mongoose");

const fineSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    fineId: {
        type: String,
        required: true,
        trim: true,
    },
    ticketNumber: {
        type: String,
        trim: true,
        index: true,
    },
    amount: {
        type: Number,
        required: true,
        default: 0,
    },
    status: {
        type: String,
        enum: ["pending", "approved", "rejected", "partially_paid", "paid"],
        default: "pending",
    },
    totalAmountWithInterest: {
        type: Number,
        default: 0,
    },
    paidAmount: {
        type: Number,
        default: 0,
    },
    interestRate: {
        type: Number,
        default: 0,
    },
    requestedAt: {
        type: Date,
        default: Date.now,
    },
    reviewedAt: {
        type: Date,
    },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

fineSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

fineSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const Fine = mongoose.model("Fine", fineSchema);

module.exports = Fine;
