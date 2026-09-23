const mongoose = require("mongoose");

const withdrawalRequestSchema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 100 },
    fee: { type: Number, required: true, min: 0 },
    totalHeld: { type: Number, required: true, min: 100 },
    phone: { type: String, required: true, trim: true },
    status: {
        type: String,
        enum: ["queued", "processing", "provider_pending", "successful", "failed"],
        default: "queued",
        index: true,
    },
    idempotencyKey: { type: String, required: true, unique: true, trim: true },
    batchId: { type: String, trim: true, index: true },
    paypackRef: { type: String, trim: true, index: true },
    failureReason: { type: String, trim: true },
    providerEvent: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

withdrawalRequestSchema.index({ driverId: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model("WithdrawalRequest", withdrawalRequestSchema);
