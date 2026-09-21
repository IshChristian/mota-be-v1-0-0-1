const PassengerKyc = require("../models/PassengerKyc");
const DriverKyc = require("../models/DriverKyc");
const User = require("../models/User");
const auditService = require("../services/auditService");

const passengerFields = ["nationalIdNumber", "nationalIdFront", "nationalIdBack", "selfie", "dateOfBirth", "residentialAddress", "emergencyContactName", "emergencyContactPhone"];
const driverFields = ["nationalIdNumber", "nationalIdFront", "nationalIdBack", "selfie", "drivingLicenseNumber", "drivingLicenseDocument", "transportPermitNumber", "transportPermitDocument", "insuranceDocument", "vehicleRegistrationDocument", "plateNumber", "cooperativeName"];
const pick = (source, fields) => fields.reduce((out, key) => { if (source[key] !== undefined) out[key] = source[key]; return out; }, {});
const isPassenger = (role) => role === "client" || role === "passenger";

async function getMine(req, res) {
  const driver = req.user.role === "driver";
  if (!driver && !isPassenger(req.user.role)) return res.status(403).json({ message: "KYC is only available to passengers and drivers" });
  const Model = driver ? DriverKyc : PassengerKyc;
  const record = await Model.findOne({ userId: req.user.id });
  res.json({ data: record, kycType: driver ? "driver" : "passenger", requirements: driver ? driverFields : passengerFields });
}

async function submitMine(req, res) {
  try {
    const driver = req.user.role === "driver";
    if (!driver && !isPassenger(req.user.role)) return res.status(403).json({ message: "KYC is only available to passengers and drivers" });
    const Model = driver ? DriverKyc : PassengerKyc;
    const fields = driver ? driverFields : passengerFields;
    const payload = pick(req.body, fields);
    const missing = fields.filter((field) => !["dateOfBirth", "residentialAddress", "emergencyContactName", "emergencyContactPhone", "cooperativeName"].includes(field) && !payload[field]);
    if (missing.length) return res.status(400).json({ message: `Missing required KYC fields: ${missing.join(", ")}` });
    const previous = await Model.findOne({ userId: req.user.id });
    if (previous?.status === "approved") return res.status(409).json({ message: "Approved KYC cannot be replaced; contact support for a reviewed correction" });
    const record = await Model.findOneAndUpdate(
      { userId: req.user.id },
      { ...payload, status: "submitted", submittedAt: new Date(), remarks: undefined, reviewedAt: undefined, reviewedBy: undefined },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await User.findByIdAndUpdate(req.user.id, { kycLevel: "basic" });
    await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "kyc_submitted", targetType: driver ? "DriverKyc" : "PassengerKyc", targetId: record._id, ipAddress: req.ip, metadata: { kycType: driver ? "driver" : "passenger" } });
    res.status(previous ? 200 : 201).json({ message: `${driver ? "Driver" : "Passenger"} KYC submitted for review`, data: record });
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 400).json({ message: error.code === 11000 ? "KYC identity or vehicle information is already registered" : error.message });
  }
}

async function adminList(req, res) {
  const type = req.query.type === "passenger" ? "passenger" : "driver";
  const Model = type === "driver" ? DriverKyc : PassengerKyc;
  const filter = req.query.status ? { status: req.query.status } : {};
  const data = await Model.find(filter).populate("userId", "firstName lastName phone email role").sort({ submittedAt: -1, createdAt: -1 }).limit(250);
  res.json({ data, kycType: type });
}

async function adminReview(req, res) {
  const type = req.params.type;
  if (!['driver', 'passenger'].includes(type)) return res.status(400).json({ message: "KYC type must be driver or passenger" });
  const status = req.body.status;
  if (!["approved", "correction", "rejected"].includes(status)) return res.status(400).json({ message: "Invalid KYC review status" });
  if (status !== "approved" && String(req.body.remarks || "").trim().length < 5) return res.status(400).json({ message: "Remarks are required for correction or rejection" });
  const Model = type === "driver" ? DriverKyc : PassengerKyc;
  const record = await Model.findByIdAndUpdate(req.params.id, { status, remarks: req.body.remarks, reviewedAt: new Date(), reviewedBy: req.user.id }, { new: true, runValidators: true });
  if (!record) return res.status(404).json({ message: "KYC record not found" });
  await User.findByIdAndUpdate(record.userId, { kycLevel: status === "approved" ? "full" : "basic" });
  await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: status === "approved" ? "kyc_verified" : "kyc_reviewed", targetType: type === "driver" ? "DriverKyc" : "PassengerKyc", targetId: record._id, ipAddress: req.ip, metadata: { kycType: type, status, remarks: req.body.remarks } });
  res.json({ message: `${type} KYC ${status}`, data: record });
}

module.exports = { getMine, submitMine, adminList, adminReview };
