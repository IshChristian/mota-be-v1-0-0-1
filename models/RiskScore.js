const mongoose = require("mongoose");

const riskScoreSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
        index: true,
    },
    score: {
        type: Number,
        default: 0,
        min: 0,
        max: 1000,
    },
    grade: {
        type: String,
        enum: ["A", "B", "C", "D", "F"],
        default: "F",
    },
    factors: {
        transactionFrequency: { type: Number, default: 0 },   // avg rides per month
        repaymentHistory: { type: Number, default: 0 },        // 0-100 percentage
        activeDaysOnPlatform: { type: Number, default: 0 },
        outstandingBalance: { type: Number, default: 0 },      // RWF
        priorLoanPerformance: { type: Number, default: 0 },    // 0-100 percentage
    },
    maxLoanEligible: {
        type: Number,
        default: 0,
    },
    lastCalculatedAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

riskScoreSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

riskScoreSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const RiskScore = mongoose.model("RiskScore", riskScoreSchema);

module.exports = RiskScore;
