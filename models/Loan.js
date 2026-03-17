const mongoose = require("mongoose");

const loanSchema = new mongoose.Schema(
    {
        driverId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        fineId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Fine",
            required: true,
        },
        loanAmount: {
            type: Number,
            required: true,
            min: 0,
        },
        interestRate: {
            type: Number,
            required: true,
            default: 5, // percentage
        },
        totalWithInterest: {
            type: Number,
            required: true,
            min: 0,
        },
        remainingBalance: {
            type: Number,
            required: true,
            min: 0,
        },
        loanStatus: {
            type: String,
            enum: ["pending", "active", "completed", "defaulted", "rejected"],
            default: "pending",
        },
        issuedAt: {
            type: Date,
        },
        dueDate: {
            type: Date,
        },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
        completedAt: {
            type: Date,
        },
    },
    { timestamps: true }
);

loanSchema.index({ driverId: 1, loanStatus: 1 });
loanSchema.index({ loanStatus: 1 });

const Loan = mongoose.model("Loan", loanSchema);

module.exports = Loan;
