const crypto = require('crypto');
const mongoose = require('mongoose');
const PaymentMethod = require('../models/PaymentMethod');
const SafetyEvent = require('../models/SafetyEvent');
const RideDispute = require('../models/RideDispute');
const ConsentRecord = require('../models/ConsentRecord');
const Ride = require('../models/Ride');
const User = require('../models/User');
const Session = require('../models/Session');
const { sendSMS } = require('../services/smsService');
const notificationService = require('../services/notificationService');

const ownRide = async (rideId, userId) => Ride.findOne({ _id: rideId, $or: [{ passengerId: userId }, { driverId: userId }] });
const publicMethod = (item) => ({ _id: item._id, type: item.type, label: item.label, maskedAccount: item.maskedAccount, status: item.status, isDefault: item.isDefault, lastFailure: item.lastFailure, createdAt: item.createdAt });

exports.listPaymentMethods = async (req, res) => res.json({ data: (await PaymentMethod.find({ userId: req.user.id }).sort({ isDefault: -1, createdAt: -1 })).map(publicMethod) });
exports.createPaymentMethod = async (req, res) => {
  try {
    const type = String(req.body.type || '').toLowerCase();
    if (!['momo', 'cash'].includes(type)) return res.status(400).json({ message: 'Supported methods are momo and cash' });
    if (type === 'cash') {
      const item = await PaymentMethod.create({ userId: req.user.id, type, label: req.body.label || 'Cash', status: 'verified', maskedAccount: 'Cash' });
      return res.status(201).json({ data: publicMethod(item) });
    }
    const phone = String(req.body.phone || '').trim();
    if (!/^\+?[0-9]{9,15}$/.test(phone)) return res.status(400).json({ message: 'A valid mobile-money phone is required' });
    const otp = String(crypto.randomInt(100000, 1000000));
    const item = await PaymentMethod.create({ userId: req.user.id, type, phone, label: req.body.label || 'Mobile Money', maskedAccount: `${phone.slice(0, 4)}••••${phone.slice(-3)}`, verificationOtpHash: crypto.createHash('sha256').update(otp).digest('hex'), verificationExpiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    await sendSMS(phone, `MOTA payment method verification code: ${otp}`, 'payment_method_verification');
    res.status(201).json({ message: 'Verification code sent', data: publicMethod(item) });
  } catch (error) { res.status(error.code === 11000 ? 409 : 400).json({ message: error.message }); }
};
exports.verifyPaymentMethod = async (req, res) => {
  const item = await PaymentMethod.findOne({ _id: req.params.id, userId: req.user.id }).select('+verificationOtpHash +verificationExpiresAt');
  const hash = crypto.createHash('sha256').update(String(req.body.otp || '')).digest('hex');
  if (!item || item.verificationOtpHash !== hash || item.verificationExpiresAt <= new Date()) return res.status(400).json({ message: 'Invalid or expired verification code' });
  item.status = 'verified'; item.verificationOtpHash = undefined; item.verificationExpiresAt = undefined; await item.save();
  res.json({ message: 'Payment method verified', data: publicMethod(item) });
};
exports.updatePaymentMethod = async (req, res) => {
  const item = await PaymentMethod.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { $set: { label: String(req.body.label || '').trim() } }, { new: true, runValidators: true });
  if (!item) return res.status(404).json({ message: 'Payment method not found' }); res.json({ data: publicMethod(item) });
};
exports.defaultPaymentMethod = async (req, res) => {
  const item = await PaymentMethod.findOne({ _id: req.params.id, userId: req.user.id, status: 'verified' });
  if (!item) return res.status(404).json({ message: 'Verified payment method not found' });
  await mongoose.connection.transaction(async (session) => { await PaymentMethod.updateMany({ userId: req.user.id }, { $set: { isDefault: false } }, { session }); item.isDefault = true; await item.save({ session }); });
  res.json({ message: 'Default payment method updated', data: publicMethod(item) });
};
exports.deletePaymentMethod = async (req, res) => {
  const item = await PaymentMethod.findOne({ _id: req.params.id, userId: req.user.id });
  if (!item) return res.status(404).json({ message: 'Payment method not found' });
  if (item.isDefault) return res.status(409).json({ message: 'Select another default method before removing this one' });
  await item.deleteOne(); res.json({ message: 'Payment method removed' });
};

exports.createSafetyEvent = async (req, res) => {
  if (req.body.rideId && !await ownRide(req.body.rideId, req.user.id)) return res.status(403).json({ message: 'Ride access denied' });
  const item = await SafetyEvent.create({ reporterId: req.user.id, rideId: req.body.rideId, type: req.body.type, category: req.body.category, description: req.body.description, location: req.body.location, evidence: req.body.evidence || [] });
  const message = `Urgent MOTA ${item.type} event ${item._id} requires support review.`;
  await notificationService.createNotification(req.user.id, 'Safety request received', 'Support has received your safety request.', 'in_app', { safetyEventId: item._id, rideId: item.rideId });
  console.warn(message); res.status(201).json({ message: 'Safety request sent to MOTA support', data: item });
};
exports.listSafetyEvents = async (req, res) => res.json({ data: await SafetyEvent.find({ reporterId: req.user.id }).sort({ createdAt: -1 }) });

exports.createDispute = async (req, res) => {
  const ride = await ownRide(req.params.rideId, req.user.id); if (!ride) return res.status(404).json({ message: 'Ride not found' });
  const reportedUserId = String(ride.passengerId) === String(req.user.id) ? ride.driverId : ride.passengerId;
  try { const item = await RideDispute.create({ rideId: ride._id, openedBy: req.user.id, reportedUserId, category: req.body.category, description: req.body.description, evidence: req.body.evidence || [], refund: { requested: Boolean(req.body.requestRefund), amount: req.body.requestRefund ? ride.heldAmount || ride.fare : undefined, status: req.body.requestRefund ? 'requested' : 'not_requested' } }); res.status(201).json({ message: 'Dispute submitted', data: item }); }
  catch (error) { res.status(error.code === 11000 ? 409 : 400).json({ message: error.code === 11000 ? 'A dispute already exists for this ride' : error.message }); }
};
exports.listDisputes = async (req, res) => res.json({ data: await RideDispute.find({ openedBy: req.user.id }).populate('rideId').sort({ createdAt: -1 }) });
exports.replyDispute = async (req, res) => { const message = String(req.body.message || '').trim(); if (!message) return res.status(400).json({ message: 'Reply is required' }); const item = await RideDispute.findOneAndUpdate({ _id: req.params.id, openedBy: req.user.id, status: { $nin: ['resolved', 'rejected'] } }, { $push: { replies: { authorId: req.user.id, message } } }, { new: true, runValidators: true }); if (!item) return res.status(409).json({ message: 'Dispute is closed or unavailable' }); res.json({ data: item }); };

exports.getPreferences = async (req, res) => { const user = await User.findById(req.user.id).select('notificationPreferences'); res.json({ data: user.notificationPreferences }); };
exports.updatePreferences = async (req, res) => { const allowed = ['rides', 'wallet', 'promotions', 'security']; const updates = {}; for (const key of allowed) if (typeof req.body[key] === 'boolean') updates[`notificationPreferences.${key}`] = req.body[key]; const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true }).select('notificationPreferences'); res.json({ data: user.notificationPreferences }); };
exports.recordConsent = async (req, res) => { const type = req.body.type; const version = String(req.body.version || '').trim(); if (!version) return res.status(400).json({ message: 'Consent version is required' }); const item = await ConsentRecord.findOneAndUpdate({ userId: req.user.id, type, version }, { granted: Boolean(req.body.granted), source: req.body.source === 'web' ? 'web' : 'mobile', ipAddress: req.ip, recordedAt: new Date() }, { upsert: true, new: true, runValidators: true }); res.json({ data: item }); };
exports.listConsents = async (req, res) => res.json({ data: await ConsentRecord.find({ userId: req.user.id }).sort({ recordedAt: -1 }) });
exports.platformStatus = async (_req, res) => res.json({ data: { status: process.env.MAINTENANCE_MODE === 'true' ? 'maintenance' : 'operational', minimumMobileVersion: process.env.MINIMUM_MOBILE_VERSION || '1.0.0', latestMobileVersion: process.env.LATEST_MOBILE_VERSION || process.env.MINIMUM_MOBILE_VERSION || '1.0.0', legalVersions: { terms: process.env.TERMS_VERSION || '2026-09', privacy: process.env.PRIVACY_VERSION || '2026-09' }, checkedAt: new Date().toISOString() } });
exports.listSessions = async (req, res) => res.json({ data: await Session.find({ userId: req.user.id, revokedAt: null, expiresAt: { $gt: new Date() } }).select('sessionId userAgent ipAddress lastSeenAt createdAt expiresAt').sort({ lastSeenAt: -1 }) });
exports.revokeSession = async (req, res) => { const item = await Session.findOneAndUpdate({ userId: req.user.id, sessionId: req.params.sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true }); if (!item) return res.status(404).json({ message: 'Active session not found' }); res.json({ message: 'Session revoked' }); };
exports.adminSafetyEvents = async (req, res) => res.json({ data: await SafetyEvent.find(req.query.status ? { status: req.query.status } : {}).populate('reporterId', 'firstName lastName phone email').populate('rideId').sort({ createdAt: -1 }).limit(250) });
exports.adminUpdateSafetyEvent = async (req, res) => { const allowed = {}; for (const key of ['status', 'assignedTo', 'resolution']) if (req.body[key] !== undefined) allowed[key] = req.body[key]; const item = await SafetyEvent.findByIdAndUpdate(req.params.id, { $set: allowed }, { new: true, runValidators: true }); if (!item) return res.status(404).json({ message: 'Safety event not found' }); res.json({ data: item }); };
exports.adminDisputes = async (req, res) => res.json({ data: await RideDispute.find(req.query.status ? { status: req.query.status } : {}).populate('openedBy reportedUserId', 'firstName lastName phone email').populate('rideId').sort({ createdAt: -1 }).limit(250) });
exports.adminUpdateDispute = async (req, res) => { const allowed = {}; for (const key of ['status', 'resolution']) if (req.body[key] !== undefined) allowed[key] = req.body[key]; if (req.body.refundStatus !== undefined) allowed['refund.status'] = req.body.refundStatus; const item = await RideDispute.findByIdAndUpdate(req.params.id, { $set: allowed }, { new: true, runValidators: true }); if (!item) return res.status(404).json({ message: 'Dispute not found' }); res.json({ data: item }); };
