const mongoose = require("mongoose");
const schema = new mongoose.Schema({
    idempotencyKey: { type: String, required: true, unique: true, trim: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
    balanceAfter: { type: Number, required: true },
}, { timestamps: true });
module.exports = mongoose.model("AdminWalletAdjustment", schema);
