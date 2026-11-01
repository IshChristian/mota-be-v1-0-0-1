const PassengerKyc = require("../models/PassengerKyc");
const DriverKyc = require("../models/DriverKyc");
const User = require("../models/User");
const auditService = require("../services/auditService");

const passengerFields = ["nationalIdNumber", "nationalIdFront", "nationalIdBack", "selfie", "dateOfBirth", "residentialAddress", "emergencyContactName", "emergencyContactPhone"];
const driverFields = ["nationalIdNumber", "nationalIdFront", "nationalIdBack", "selfie", "drivingLicenseNumber", "drivingLicenseDocument", "drivingLicenseExpiresAt", "transportPermitNumber", "transportPermitDocument", "transportPermitExpiresAt", "insuranceDocument", "insuranceExpiresAt", "vehicleRegistrationDocument", "vehicleRegistrationExpiresAt", "technicalInspectionDocument", "technicalInspectionExpiresAt", "vocationalCardDocument", "vocationalCardExpiresAt", "plateNumber", "vehicleType", "powertrain", "cooperativeName"];
const pick = (source, fields) => fields.reduce((out, key) => { if (source[key] !== undefined) out[key] = source[key]; return out; }, {});
const isPassenger = (role) => role === "client" || role === "passenger";

// Required driver documents and their expiry fields. Renewal opens 30 days before expiry.
const DRIVER_EXPIRY_FIELDS = { drivingLicenseExpiresAt: "drivingLicenseDocument", transportPermitExpiresAt: "transportPermitDocument", insuranceExpiresAt: "insuranceDocument", vehicleRegistrationExpiresAt: "vehicleRegistrationDocument", technicalInspectionExpiresAt: "technicalInspectionDocument" };
const RENEWAL_WINDOW_DAYS = 30;
function renewalStatus(record) {
  const now = Date.now(), soon = now + RENEWAL_WINDOW_DAYS * 86400000;
  const expired = [], expiringSoon = [];
  const fields = { ...DRIVER_EXPIRY_FIELDS, ...(record?.vocationalCardDocument ? { vocationalCardExpiresAt: "vocationalCardDocument" } : {}) };
  for (const [expiryField, documentField] of Object.entries(fields)) {
    const at = record?.[expiryField] ? new Date(record[expiryField]).getTime() : NaN;
    if (!Number.isFinite(at) || at <= now) expired.push({ expiryField, documentField, expiresAt: record?.[expiryField] || null });
    else if (at <= soon) expiringSoon.push({ expiryField, documentField, expiresAt: record[expiryField] });
  }
  return { due: expired.length + expiringSoon.length > 0, expired, expiringSoon, windowDays: RENEWAL_WINDOW_DAYS };
}

async function getMine(req, res) {
  const driver = req.user.role === "driver";
  if (!driver && !isPassenger(req.user.role)) return res.status(403).json({ message: "KYC is only available to passengers and drivers" });
  const Model = driver ? DriverKyc : PassengerKyc;
  const record = await Model.findOne({ userId: req.user.id });
  const renewal = driver && record?.status === "approved" ? renewalStatus(record) : undefined;
  res.json({ data: record, kycType: driver ? "driver" : "passenger", requirements: driver ? driverFields : passengerFields, renewal });
}

async function submitMine(req, res) {
  try {
    const driver = req.user.role === "driver";
    if (!driver && !isPassenger(req.user.role)) return res.status(403).json({ message: "KYC is only available to passengers and drivers" });
    const Model = driver ? DriverKyc : PassengerKyc;
    const fields = driver ? driverFields : passengerFields;
    const payload = pick(req.body, fields);
    const missing = fields.filter((field) => !["dateOfBirth", "residentialAddress", "emergencyContactName", "emergencyContactPhone", "cooperativeName", "vocationalCardDocument", "vocationalCardExpiresAt"].includes(field) && !payload[field]);
    if (missing.length) return res.status(400).json({ message: `Missing required KYC fields: ${missing.join(", ")}` });
    if (driver) {
      if (!["car", "moto"].includes(payload.vehicleType) || !["electric", "diesel", "petrol"].includes(payload.powertrain)) return res.status(400).json({ message: "Select a valid vehicle and power type" });
      const invalidExpiry = ["drivingLicenseExpiresAt", "transportPermitExpiresAt", "insuranceExpiresAt", "vehicleRegistrationExpiresAt", "technicalInspectionExpiresAt", ...(payload.vocationalCardDocument || payload.vocationalCardExpiresAt ? ["vocationalCardExpiresAt"] : [])].find((field) => !Number.isFinite(Date.parse(payload[field])) || Date.parse(payload[field]) <= Date.now());
      if (invalidExpiry) return res.status(400).json({ message: `${invalidExpiry} must be a future date` });
    }
    const previous = await Model.findOne({ userId: req.user.id });
    // Approved KYC stays locked, except for drivers whose documents have expired or expire soon:
    // they resubmit for review (they cannot go online with an expired document anyway).
    const renewal = previous?.status === "approved" && driver ? renewalStatus(previous) : null;
    if (previous?.status === "approved" && !renewal?.due) {
      return res.status(409).json({ message: `Your approved documents are still valid. You can renew a document from ${RENEWAL_WINDOW_DAYS} days before it expires, or contact support for a correction.` });
    }
    const record = await Model.findOneAndUpdate(
      { userId: req.user.id },
      { ...payload, status: "submitted", submittedAt: new Date(), remarks: undefined, reviewedAt: undefined, reviewedBy: undefined },
      { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true }
    );
    await User.findByIdAndUpdate(req.user.id, { kycLevel: "basic" });
    await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "kyc_submitted", targetType: driver ? "DriverKyc" : "PassengerKyc", targetId: record._id, ipAddress: req.ip, metadata: { kycType: driver ? "driver" : "passenger", renewal: Boolean(renewal?.due), renewedDocuments: renewal ? [...renewal.expired, ...renewal.expiringSoon].map((d) => d.documentField) : undefined } });
    res.status(previous ? 200 : 201).json({ message: renewal?.due ? "Renewed documents sent for review. You can go online again once they are approved." : `${driver ? "Driver" : "Passenger"} KYC submitted for review`, data: record, renewal: Boolean(renewal?.due) });
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

async function adminDetail(req, res) {
  const type = req.params.type;
  if (!["driver", "passenger"].includes(type)) return res.status(400).json({ message: "KYC type must be driver or passenger" });
  const Model = type === "driver" ? DriverKyc : PassengerKyc;
  const record = await Model.findById(req.params.id).populate("userId", "firstName lastName phone email role").catch(() => null);
  if (!record) return res.status(404).json({ message: "KYC record not found" });
  res.json({ data: record, kycType: type, requirements: type === "driver" ? driverFields : passengerFields });
}

// ── Staff field edits ───────────────────────────────────────────────────────
const OPTIONAL_FIELDS = new Set(["dateOfBirth", "residentialAddress", "emergencyContactName", "emergencyContactPhone", "cooperativeName", "vocationalCardDocument", "vocationalCardExpiresAt"]);
const isDocumentField = (key) => /Document$|^nationalIdFront$|^nationalIdBack$|^selfie$/.test(key);
const isDateField = (key) => /ExpiresAt$|^dateOfBirth$/.test(key);

/** Returns [cleanValue, error, warning]. undefined value = clear an optional field. */
function cleanKycValue(key, raw) {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) return OPTIONAL_FIELDS.has(key) ? [undefined] : [null, `${key} is required and can't be emptied.`];
  if (isDocumentField(key)) return /^https:\/\/\S+$/i.test(text) ? [text] : [null, `${key} must be a secure https link to the file.`];
  if (isDateField(key)) {
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T12:00:00Z` : text);
    if (Number.isNaN(date.getTime())) return [null, `${key} must be a valid date (YYYY-MM-DD).`];
    const warning = /ExpiresAt$/.test(key) && date.getTime() <= Date.now() ? `${key} is in the past: the driver can't go online until it is renewed.` : undefined;
    return [date, undefined, warning];
  }
  if (key === "vehicleType") return ["car", "moto"].includes(text) ? [text] : [null, "vehicleType must be car or moto."];
  if (key === "powertrain") return ["electric", "diesel", "petrol"].includes(text) ? [text] : [null, "powertrain must be electric, diesel or petrol."];
  if (key === "emergencyContactPhone") {
    const phone = require("../utils/rwandaPhone").normalizeRwandaPhone(text);
    return phone ? [phone] : [null, "emergencyContactPhone must be a valid Rwandan number."];
  }
  if (key === "plateNumber") return [text.toUpperCase().slice(0, 20)];
  return [text.slice(0, 200)];
}

/** PATCH /api/admin/kyc/:type/:id/fields — staff correct individual KYC values. */
async function adminUpdateFields(req, res) {
  const type = req.params.type;
  if (!["driver", "passenger"].includes(type)) return res.status(400).json({ message: "KYC type must be driver or passenger" });
  const allowed = type === "driver" ? driverFields : passengerFields;
  const updates = req.body?.updates && typeof req.body.updates === "object" ? req.body.updates : null;
  if (!updates || !Object.keys(updates).length) return res.status(400).json({ message: "Send at least one field to update." });
  const reason = String(req.body.reason || "").trim();
  if (reason.length < 5) return res.status(400).json({ message: "Give a reason of at least 5 characters (it is saved in the audit log)." });
  const unknown = Object.keys(updates).filter((k) => !allowed.includes(k));
  if (unknown.length) return res.status(400).json({ message: `Not an editable ${type} KYC field: ${unknown.join(", ")}` });

  const set = {}, unset = {}, errors = [], warnings = [];
  for (const [key, raw] of Object.entries(updates)) {
    const [value, error, warning] = cleanKycValue(key, raw);
    if (error) errors.push(error);
    else if (value === undefined) unset[key] = 1;
    else set[key] = value;
    if (warning) warnings.push(warning);
  }
  if (errors.length) return res.status(400).json({ message: errors.join(" ") });

  const Model = type === "driver" ? DriverKyc : PassengerKyc;
  const current = await Model.findById(req.params.id).catch(() => null);
  if (!current) return res.status(404).json({ message: "KYC record not found" });
  const filter = { _id: current._id };
  if (req.body.expectedUpdatedAt) {
    const expected = new Date(req.body.expectedUpdatedAt);
    if (!Number.isNaN(expected.getTime())) filter.updatedAt = expected;
  }
  const changed = [...Object.keys(set), ...Object.keys(unset)];
  const before = Object.fromEntries(changed.map((k) => [k, current[k] ?? null]));
  try {
    const record = await Model.findOneAndUpdate(filter, {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      // A changed value needs a fresh decision from the reviewer.
      $pull: { fieldReviews: { key: { $in: changed } } },
    }, { returnDocument: "after", runValidators: true }).populate("userId", "firstName lastName phone email role");
    if (!record) return res.status(409).json({ message: "This KYC record changed since you opened it. Reload it and edit again." });
    await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "kyc_fields_updated", targetType: type === "driver" ? "DriverKyc" : "PassengerKyc", targetId: record._id, ipAddress: req.ip, metadata: { before, after: Object.fromEntries(changed.map((k) => [k, record[k] ?? null])), reason } });
    await require("../services/notificationService").createNotification(record.userId?._id || record.userId, "Verification details updated", `MOTA staff updated your ${type} verification details (${changed.length} field${changed.length > 1 ? "s" : ""}).`, "in_app", { event: "accountUpdate" }).catch(() => {});
    res.json({ message: `Updated ${changed.length} field${changed.length > 1 ? "s" : ""}.`, data: record, warnings });
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 400).json({ message: error.code === 11000 ? "That value is already registered on another KYC record." : error.message });
  }
}

async function adminReview(req, res) {
  const type = req.params.type;
  if (!['driver', 'passenger'].includes(type)) return res.status(400).json({ message: "KYC type must be driver or passenger" });
  const status = req.body.status;
  if (!["approved", "correction", "rejected"].includes(status)) return res.status(400).json({ message: "Invalid KYC review status" });
  if (status !== "approved" && String(req.body.remarks || "").trim().length < 5) return res.status(400).json({ message: "Remarks are required for correction or rejection" });
  const Model = type === "driver" ? DriverKyc : PassengerKyc;
  const fieldReviews = Array.isArray(req.body.fieldReviews)
    ? req.body.fieldReviews.filter((r) => r && typeof r.key === "string").slice(0, 60).map((r) => ({ key: r.key, status: String(r.status || ""), reason: String(r.reason || "").slice(0, 500) }))
    : undefined;
  // Two reviewers on the same record: the second save must not silently overwrite the first.
  const filter = { _id: req.params.id };
  if (req.body.expectedUpdatedAt) {
    const expected = new Date(req.body.expectedUpdatedAt);
    if (!Number.isNaN(expected.getTime())) filter.updatedAt = expected;
  }
  const update = { status, remarks: req.body.remarks, reviewedAt: new Date(), reviewedBy: req.user.id, ...(fieldReviews ? { fieldReviews } : {}) };
  const record = await Model.findOneAndUpdate(filter, update, { returnDocument: "after", runValidators: true }).catch(() => null);
  if (!record) {
    const exists = await Model.exists({ _id: req.params.id }).catch(() => null);
    return res.status(exists ? 409 : 404).json({ message: exists ? "This KYC record changed since you opened it. Reload it and review again." : "KYC record not found" });
  }
  const warnings = status === "approved" && fieldReviews?.some((r) => r.status && !["approved", "accepted", "ok"].includes(r.status))
    ? ["Some fields were flagged but the record was approved overall."] : [];
  await User.findByIdAndUpdate(record.userId, { kycLevel: status === "approved" ? "full" : "basic" });
  await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: status === "approved" ? "kyc_verified" : "kyc_reviewed", targetType: type === "driver" ? "DriverKyc" : "PassengerKyc", targetId: record._id, ipAddress: req.ip, metadata: { kycType: type, status, remarks: req.body.remarks } });
  res.json({ message: `${type} KYC ${status}`, data: record, warnings });
}

module.exports = { getMine, submitMine, adminList, adminDetail, adminReview, adminUpdateFields };
