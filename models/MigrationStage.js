const mongoose = require("mongoose");

const migrationStageSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
        index: true,
    },
    currentStage: {
        type: String,
        enum: [
            "fine_entry",
            "repayment_trust",
            "transaction_adoption",
            "savings_adoption",
            "long_term_retention",
        ],
        default: "fine_entry",
    },
    stageHistory: [{
        stage: { type: String, required: true },
        enteredAt: { type: Date, default: Date.now },
        exitedAt: { type: Date },
        triggerEvent: { type: String },
    }],
    milestones: {
        firstLoanActivated: { type: Date },
        firstLoanRepaid: { type: Date },
        firstTransactionAfterLoan: { type: Date },
        transactionCount30d: { type: Number, default: 0 },
        savingsActivated: { type: Date },
        savingsHeld30d: { type: Date },
    },
    updatedAt: { type: Date, default: Date.now },
});

migrationStageSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

migrationStageSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const MigrationStage = mongoose.model("MigrationStage", migrationStageSchema);

module.exports = MigrationStage;
