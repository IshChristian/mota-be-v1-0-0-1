const mongoose = require("mongoose");
const supportCaseSchema = new mongoose.Schema({
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal", index: true },
    status: { type: String, enum: ["open", "in_progress", "resolved", "closed"], default: "open", index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolution: { type: String, trim: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
supportCaseSchema.index({ status: 1, priority: 1, createdAt: -1 });
module.exports = mongoose.model("SupportCase", supportCaseSchema);
