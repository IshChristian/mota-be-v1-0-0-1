const mongoose = require("mongoose");
const supportCaseSchema = new mongoose.Schema({
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride", index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    category: { type: String, enum: ["ride_assignment", "acceptance_notification", "driver_arrival", "ride_start", "ride_stop", "payment", "cancellation", "other"], default: "other" },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal", index: true },
    status: { type: String, enum: ["open", "in_progress", "resolved", "closed"], default: "open", index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolution: { type: String, trim: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    escalated: { type: Boolean, default: false },
    contactHistory: [{ channel: { type: String, enum: ["call", "sms", "email", "push", "in_app"] }, direction: { type: String, enum: ["outbound", "inbound"], default: "outbound" }, outcome: { type: String, enum: ["answered", "no_answer", "sent", "failed", "callback_requested", "resolved"] }, note: { type: String, trim: true, maxlength: 1000 }, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, createdAt: { type: Date, default: Date.now } }],
    lastPassengerNotificationAt: { type: Date },
}, { timestamps: true });
supportCaseSchema.index({ status: 1, priority: 1, createdAt: -1 });
module.exports = mongoose.model("SupportCase", supportCaseSchema);
