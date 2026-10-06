const mongoose = require("mongoose");
const { CATEGORIES, STATUSES } = require("../constants/support");
const supportCaseSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride", index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    category: { type: String, enum: CATEGORIES, default: "other" },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    priority: {
      type: String,
      enum: ["low", "normal", "high", "urgent"],
      default: "normal",
      index: true,
    },
    status: { type: String, enum: STATUSES, default: "open", index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolution: { type: String, trim: true, maxlength: 4000 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    escalated: { type: Boolean, default: false },
    contactHistory: [
      {
        channel: {
          type: String,
          enum: ["call", "sms", "email", "push", "in_app"],
        },
        direction: {
          type: String,
          enum: ["outbound", "inbound"],
          default: "outbound",
        },
        outcome: {
          type: String,
          enum: [
            "answered",
            "no_answer",
            "sent",
            "failed",
            "callback_requested",
            "resolved",
          ],
        },
        note: { type: String, trim: true, maxlength: 1000 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    lastPassengerNotificationAt: { type: Date },
    responseDueAt: Date,
    staffAlertCancelled: { type: Boolean, default: false },
    staffAlertRevision: { type: Number, default: 0 },
    staffAlertedRevision: { type: Number, default: -1 },
    staffOverdueAlertedFor: Date,
    messages: [
      {
        text: { type: String, required: true, maxlength: 4000 },
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        authorType: { type: String, enum: ["user", "staff"], required: true },
        internal: { type: Boolean, default: false },
        notificationPending: { type: Boolean, default: false },
        notificationRecordedAt: Date,
        attachments: [{ url: String, name: String }],
        createdAt: { type: Date, default: Date.now },
      },
    ],
    attachments: [{ url: String, name: String }],
  },
  { timestamps: true },
);
supportCaseSchema.index({ status: 1, priority: 1, createdAt: -1 });
supportCaseSchema.index({ status: 1, responseDueAt: 1 });
supportCaseSchema.index({ "messages.notificationPending": 1, updatedAt: 1 });
module.exports = mongoose.model("SupportCase", supportCaseSchema);
