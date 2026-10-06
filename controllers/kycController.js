const PassengerKyc = require("../models/PassengerKyc");
const DriverKyc = require("../models/DriverKyc");
const User = require("../models/User");
const mongoose = require("mongoose");
const auditService = require("../services/auditService");

const passengerFields = ["nationalIdNumber", "nationalIdFront", "nationalIdBack", "selfie", "dateOfBirth", "residentialAddress", "emergencyContactName", "emergencyContactPhone"];
const driverFields = ["nationalIdNumber", "nationalIdFront", "nationalIdBack", "selfie", "drivingLicenseNumber", "drivingLicenseDocument", "drivingLicenseExpiresAt", "transportPermitNumber", "transportPermitDocument", "transportPermitExpiresAt", "insuranceDocument", "insuranceExpiresAt", "vehicleRegistrationDocument", "vehicleRegistrationExpiresAt", "technicalInspectionDocument", "technicalInspectionExpiresAt", "vocationalCardDocument", "vocationalCardExpiresAt", "plateNumber", "vehicleType", "powertrain", "cooperativeName"];
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
    const missing = fields.filter((field) => !["dateOfBirth", "residentialAddress", "emergencyContactName", "emergencyContactPhone", "cooperativeName", "vocationalCardDocument", "vocationalCardExpiresAt"].includes(field) && !payload[field]);
    if (missing.length) return res.status(400).json({ message: `Missing required KYC fields: ${missing.join(", ")}` });
    if (driver) {
      if (!["car", "moto"].includes(payload.vehicleType) || !["electric", "diesel", "petrol"].includes(payload.powertrain)) return res.status(400).json({ message: "Select a valid vehicle and power type" });
      const invalidExpiry = ["drivingLicenseExpiresAt", "transportPermitExpiresAt", "insuranceExpiresAt", "vehicleRegistrationExpiresAt", "technicalInspectionExpiresAt", ...(payload.vocationalCardDocument || payload.vocationalCardExpiresAt ? ["vocationalCardExpiresAt"] : [])].find((field) => !Number.isFinite(Date.parse(payload[field])) || Date.parse(payload[field]) <= Date.now());
      if (invalidExpiry) return res.status(400).json({ message: `${invalidExpiry} must be a future date` });
    }
    const previous = await Model.findOne({ userId: req.user.id });
    if (previous?.status === "approved") return res.status(409).json({ message: "Approved KYC cannot be replaced; contact support for a reviewed correction" });
    const record = await Model.findOneAndUpdate(
      { userId: req.user.id },
      { ...payload, status: "submitted", submittedAt: new Date(), fieldReviews: [], documentReviews: [], remarks: "", reviewedAt: null, reviewedBy: null },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await User.findByIdAndUpdate(req.user.id, { kycLevel: "basic" });
    await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "kyc_submitted", targetType: driver ? "DriverKyc" : "PassengerKyc", targetId: record._id, ipAddress: req.ip, metadata: { kycType: driver ? "driver" : "passenger" } });
    res.status(previous ? 200 : 201).json({ message: `${driver ? "Driver" : "Passenger"} KYC submitted for review`, data: record });
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 400).json({ message: error.code === 11000 ? "KYC identity or vehicle information is already registered" : error.message });
  }
}

async function adminList(req,res) {
  const type=req.query.type||'driver';
  if(!['driver','passenger'].includes(type))return res.status(400).json({message:'Invalid KYC type.'});
  const Model=type==='driver'?DriverKyc:PassengerKyc;
  if(req.query.status&&!['draft','submitted','approved','correction','rejected'].includes(req.query.status))return res.status(400).json({message:'Invalid KYC status.'});
  const filter=req.query.status?{status:req.query.status}:{};
  const page=Math.max(parseInt(req.query.page)||1,1),limit=Math.min(Math.max(parseInt(req.query.limit)||25,1),100);
  const [data,total]=await Promise.all([Model.find(filter).populate('userId','firstName lastName phone email role').sort({submittedAt:-1,createdAt:-1,_id:-1}).skip((page-1)*limit).limit(limit),Model.countDocuments(filter)]);
  res.json({data,kycType:type,requirements:type==='driver'?driverFields:passengerFields,pagination:{page,limit,total,pages:Math.max(1,Math.ceil(total/limit))}});
}
async function adminDetail(req,res) {
  if(!['driver','passenger'].includes(req.params.type))return res.status(400).json({message:'Invalid KYC type.'});
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid KYC ID.'});
  const Model=req.params.type==='driver'?DriverKyc:PassengerKyc;
  const record=await Model.findById(req.params.id).populate('userId','firstName lastName phone email role');
  if(!record)return res.status(404).json({message:'KYC not found.'});
  res.json({data:record,requirements:req.params.type==='driver'?driverFields:passengerFields});
}

async function adminReview(req, res) {
  const type = req.params.type;
  if (!['driver', 'passenger'].includes(type)) return res.status(400).json({ message: "KYC type must be driver or passenger" });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:"Invalid KYC ID."});
  if (req.body.expectedUpdatedAt && !Number.isFinite(Date.parse(req.body.expectedUpdatedAt))) return res.status(400).json({message:"Invalid submission version. Refresh KYC details."});
  const status = req.body.status;
  if (!["approved", "correction", "rejected"].includes(status)) return res.status(400).json({ message: "Invalid KYC review status" });
  if (status !== "approved" && String(req.body.remarks || "").trim().length < 5) return res.status(400).json({ message: "Remarks are required for correction or rejection" });
  const Model = type === "driver" ? DriverKyc : PassengerKyc;
  const previous=await Model.findById(req.params.id);
  if(!previous)return res.status(404).json({message:'KYC record not found'});
  const fields=type==='driver'?driverFields:passengerFields;
  let reviews;
  try {
    if(req.body.fieldReviews!==undefined){
      if(!req.body.expectedUpdatedAt)return res.status(400).json({message:'Refresh KYC details before reviewing.'});
      reviews=require('../services/kycFieldReview').validateFieldReviews(fields,previous,req.body.fieldReviews,status).map(r=>({...r,reviewedAt:new Date(),reviewedBy:req.user.id}));
    } else if(status==='approved'&&previous.fieldReviews?.some(r=>r.status==='correction'))return res.status(400).json({message:'Resolve field corrections before approving KYC.'});
    if(status==='approved'&&fields.some(key=>key.endsWith('ExpiresAt')&&previous[key]&&new Date(previous[key]).getTime()<=Date.now()))return res.status(400).json({message:'Expired documents cannot be approved.'});
  }catch(error){return res.status(error.status||400).json({message:error.message});}
  const query={_id:req.params.id,...(req.body.expectedUpdatedAt||previous.updatedAt?{updatedAt:new Date(req.body.expectedUpdatedAt||previous.updatedAt)}:{})};
  const session = await mongoose.startSession();
  let record, reviewedUser;
  try {
    await session.withTransaction(async () => {
      record = await Model.findOneAndUpdate(query, {status,remarks:String(req.body.remarks || '').trim(),reviewedAt:new Date(),reviewedBy:req.user.id,...(reviews?{fieldReviews:reviews}:{})}, {new:true,runValidators:true,session});
      if (!record) throw Object.assign(new Error('This KYC changed while you were reviewing it. Refresh the details.'), {status:409});
      reviewedUser = await User.findByIdAndUpdate(record.userId, {kycLevel:status === 'approved'?'full':'basic',...(status !== 'approved'?{isOnline:false}:{})}, {new:true,session});
      if (!reviewedUser) throw Object.assign(new Error('The submitted account no longer exists.'), {status:409});
      if (status === 'approved') await require('../services/driverActivation').activateFullKycDriver(reviewedUser, {session});
    });
  } catch (error) {
    return res.status(error.status || 500).json({message:error.status?error.message:'Could not save KYC review. No changes were committed.'});
  } finally { await session.endSession(); }
  // Referral settlement is independent; a referral error must not report a committed review as failed.
  const warnings = [];
  if (status === 'approved') {
    try { await require('../services/referralService').trySettleReferral(record.userId); }
    catch (error) { warnings.push('KYC was saved, but referral settlement needs a retry.'); console.error('[KYC] Referral settlement:', error.message); }
  }
  await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: status === "approved" ? "kyc_verified" : "kyc_reviewed", targetType: type === "driver" ? "DriverKyc" : "PassengerKyc", targetId: record._id, ipAddress: req.ip, metadata: { kycType: type, status, remarks: req.body.remarks, fieldReviews:reviews } });
  res.json({ message: `${type} KYC ${status}`, data: record, warnings });
}

module.exports = { getMine, submitMine, adminList, adminDetail, adminReview };
