const mongoose = require("mongoose");

const driverKycSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  nationalIdNumber: { type: String, trim: true, required: true },
  nationalIdFront: { type: String, required: true, trim: true },
  nationalIdBack: { type: String, required: true, trim: true },
  selfie: { type: String, required: true, trim: true },
  drivingLicenseNumber: { type: String, required: true, trim: true },
  drivingLicenseDocument: { type: String, required: true, trim: true },
  transportPermitNumber: { type: String, required: true, trim: true },
  transportPermitDocument: { type: String, required: true, trim: true },
  insuranceDocument: { type: String, required: true, trim: true },
  vehicleRegistrationDocument: { type: String, required: true, trim: true },
  plateNumber: { type: String, required: true, trim: true },
  cooperativeName: { type: String, trim: true },
  status: { type: String, enum: ["draft", "submitted", "approved", "correction", "rejected"], default: "draft", index: true },
  remarks: { type: String, trim: true },
  submittedAt: Date,
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

module.exports = mongoose.model("DriverKyc", driverKycSchema);
