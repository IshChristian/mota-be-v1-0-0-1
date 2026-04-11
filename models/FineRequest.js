const mongoose = require("mongoose");

const fineRequestSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    fineId: {
        type: String,
        required: true,
        trim: true,
    },
    amount: {
        type: Number,
        required: true,
        min: 0,
    },
    reason: {
        type: String,
        trim: true,
    },
    // Evidence / supporting docs
    attachments: [{
        url: String,
        description: String,
    }],
    status: {
        type: String,
        enum: ["pending", "under_review", "approved", "rejected"],
        default: "pending",
    },
    // Approval workflow
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    reviewedAt: {
        type: Date,
    },
    reviewNotes: {
        type: String,
        trim: true,
    },
    // Resulting fine record (created on approval)
    resultingFineId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Fine",
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

fineRequestSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

fineRequestSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

fineRequestSchema.index({ driverId: 1, status: 1 });
fineRequestSchema.index({ status: 1, createdAt: -1 });

const FineRequest = mongoose.model("FineRequest", fineRequestSchema);

module.exports = FineRequest;
