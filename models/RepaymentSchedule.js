const mongoose = require("mongoose");

const installmentSchema = new mongoose.Schema({
    installmentNumber: { type: Number, required: true },
    dueDate: { type: Date, required: true },
    amount: { type: Number, required: true },
    paidAmount: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ["upcoming", "paid", "partial", "overdue", "waived"],
        default: "upcoming",
    },
    paidAt: { type: Date },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
}, { _id: true });

const repaymentScheduleSchema = new mongoose.Schema({
    loanId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Loan",
        required: true,
        index: true,
    },
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    installments: [installmentSchema],
    frequency: {
        type: String,
        enum: ["daily", "weekly", "monthly"],
        default: "monthly",
    },
    totalInstallments: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

repaymentScheduleSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

repaymentScheduleSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const RepaymentSchedule = mongoose.model("RepaymentSchedule", repaymentScheduleSchema);

module.exports = RepaymentSchedule;
