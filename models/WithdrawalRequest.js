const mongoose = require("mongoose");

const withdrawalRequestSchema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 100 },
    fee: { type: Number, required: true, min: 0 },
    totalHeld: { type: Number, required: true, min: 100 },
    phone: { type: String, required: true, trim: true },
    reviewStatus: { type: String, enum: ["new", "in_review", "resolved"], default: "new", index: true },
    reviewNote: { type: String, trim: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: Date,
    status: {
        type: String,
        // manual_required: Paypack refused at send time; the money stays held until staff pay or return it.
        enum: ["queued", "processing", "provider_pending", "manual_required", "successful", "failed"],
        default: "queued",
        index: true,
    },
    idempotencyKey: { type: String, required: true, unique: true, trim: true },
    batchId: { type: String, trim: true, index: true },
    paypackRef: { type: String, trim: true, index: true },
    failureReason: { type: String, trim: true },
    providerEvent: { type: mongoose.Schema.Types.Mixed },
    // Every Paypack attempt, kept for staff and audits (never credentials).
    attempts: [{
        _id: false,
        at: { type: Date, default: Date.now },
        kind: { type: String, enum: ["auto", "retry"], default: "auto" },
        ok: Boolean,
        paypackRef: String,
        reason: String,
        response: mongoose.Schema.Types.Mixed,
    }],
    alertedAt: Date,
    alertedStaff: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    manual: {
        action: { type: String, enum: ["paid", "returned"] },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        at: Date,
        reference: String,
        note: String,
    },
}, { timestamps: true });

withdrawalRequestSchema.index({ driverId: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model("WithdrawalRequest", withdrawalRequestSchema);
