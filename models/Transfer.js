const mongoose = require("mongoose");

const transferSchema = new mongoose.Schema({
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    receiverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    amount: {
        type: Number,
        required: true,
        min: 1,
    },
    feeAmount: {
        type: Number,
        default: 0,
    },
    method: {
        type: String,
        enum: ["direct", "qr_code"],
        default: "direct",
    },
    status: {
        type: String,
        enum: ["pending", "successful", "failed", "reversed"],
        default: "successful",
    },
    reference: {
        type: String,
        unique: true,
        required: true,
    },
    description: {
        type: String,
        trim: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true,
    },
});

transferSchema.index({ senderId: 1, createdAt: -1 });
transferSchema.index({ receiverId: 1, createdAt: -1 });

const Transfer = mongoose.model("Transfer", transferSchema);

module.exports = Transfer;
