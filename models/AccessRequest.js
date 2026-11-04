const mongoose = require("mongoose");

// A staff member asks the superadmin for one permission, usually on one record.
// Approval is single use: authorize() consumes it on the matching action.
const accessRequestSchema = new mongoose.Schema({
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    permission: { type: String, required: true, trim: true },
    targetType: { type: String, trim: true },
    targetId: { type: String, trim: true, default: null },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: ["pending", "approved", "declined", "used"], default: "pending", index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    decidedAt: Date,
    decisionNote: { type: String, trim: true, maxlength: 500 },
    expiresAt: Date,
    usedAt: Date,
}, { timestamps: true });

accessRequestSchema.index({ requesterId: 1, permission: 1, targetId: 1, status: 1 });

module.exports = mongoose.model("AccessRequest", accessRequestSchema);
