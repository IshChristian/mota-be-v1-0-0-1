const mongoose = require("mongoose");

const passengerKycSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  nationalIdNumber: { type: String, trim: true, required: true },
  nationalIdFront: { type: String, required: true, trim: true },
  nationalIdBack: { type: String, required: true, trim: true },
  selfie: { type: String, required: true, trim: true },
  dateOfBirth: { type: Date },
  residentialAddress: { type: String, trim: true },
  emergencyContactName: { type: String, trim: true },
  emergencyContactPhone: { type: String, trim: true },
  status: { type: String, enum: ["draft", "submitted", "approved", "correction", "rejected"], default: "draft", index: true },
  remarks: { type: String, trim: true },
  submittedAt: Date,
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

module.exports = mongoose.model("PassengerKyc", passengerKycSchema);
