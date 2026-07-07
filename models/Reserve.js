const mongoose = require("mongoose");

const reserveSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["loan_loss", "working_capital"],
        required: true,
        unique: true,
    },
    balance: { type: Number, default: 0, min: 0 },
    targetBalance: { type: Number, default: 0 },
    lastTopUpAt: { type: Date },
    transactions: [{
        amount: { type: Number, required: true },
        direction: {
            type: String,
            enum: ["in", "out"],
            required: true,
        },
        reason: { type: String, trim: true },
        timestamp: { type: Date, default: Date.now },
    }],
    updatedAt: { type: Date, default: Date.now },
});

reserveSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

const Reserve = mongoose.model("Reserve", reserveSchema);

module.exports = Reserve;
