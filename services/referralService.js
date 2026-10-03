const mongoose = require('mongoose');
const User = require('../models/User');
const Referral = require('../models/Referral');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const configService = require('./configService');

const normalizeCode = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const rewardEligible = (referrerRole, referredRole) => ['driver', 'agent'].includes(referrerRole) && referredRole === 'driver';
async function resolveReferral(code, referredRole) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const referrer = await User.findOne({ referralCode: normalized });
    if (!referrer || referrer.deletedAt || !["driver", "agent", "client", "passenger"].includes(referrer.role)) { const error = new Error('Referral code was not found. Check the code or leave it empty.'); error.status = 400; throw error; }
    const configured = Number(await configService.getConfig('referral_reward_amount', 5000));
    if (!Number.isFinite(configured) || configured < 0) throw new Error('Referral reward configuration is invalid');
    return { referrer, reward: rewardEligible(referrer.role, referredRole) ? configured : 0 };
}
async function recordReferral(user) {
    if (!user.referredBy || String(user.referredBy) === String(user._id)) return null;
    const existing = await Referral.findOne({ referredUserId: user._id });
    if (existing) return existing;
    return Referral.findOneAndUpdate({ _id: user._id }, { $setOnInsert: { referrerId: user.referredBy, referredUserId: user._id, reward: user.referralReward || 0, status: 'pending' } }, { upsert: true, new: true });
}
async function settleReferral(userId) {
    const user = await User.findById(userId);
    if (!user) return;
    await recordReferral(user); // Recover a record if registration lost its response.
    // Cash rewards require the complete driver verification and payment workflow.
    if (user.role === 'driver' && !(user.isVerified && user.kycLevel === 'full' && user.registrationPaid && user.registrationStatus === 'approved')) return;
    if (user.role !== 'driver' && !(user.isVerified && user.kycLevel === 'full')) return;
    const pending = await Referral.findOne({ referredUserId: userId, status: 'pending' });
    if (!pending) return;
    // Historical pending records may already have been credited by the old non-atomic flow.
    // Require new persisted attribution before automated cash settlement.
    if (!user.referredBy || String(user.referredBy) !== String(pending.referrerId)) return;
    const owner = await User.findById(pending.referrerId);
    if (!rewardEligible(owner?.role, user.role) || Number(pending.reward) === 0) {
        await Referral.updateMany({ referredUserId: userId, status: 'pending' }, { $set: { status: 'successful', reward: 0, rewardedAt: new Date() } });
        return;
    }
    if (process.env.FINANCIAL_WRITES_ENABLED !== 'true') return;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const current = await User.findById(userId).session(session);
            if (!current || !current.isVerified || current.kycLevel !== 'full' || !current.registrationPaid || current.registrationStatus !== 'approved' || current.role !== 'driver') return;
            const referral = await Referral.findOne({ referredUserId: userId, status: 'pending' }).session(session);
            if (!referral) return;
            const referrer = await User.findById(referral.referrerId).session(session);
            const amount = rewardEligible(referrer?.role, user.role) ? Number(referral.reward) : 0;
            if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid referral reward');
            const key = `referral:${userId}`;
            const existing = await Transaction.findOne({ idempotencyKey: key }).session(session);
            if (amount > 0 && !existing) {
                await Wallet.findOneAndUpdate({ driverId: referral.referrerId }, { $inc: { balance: amount }, $setOnInsert: { heldBalance: 0, fuelCredits: 0 } }, { upsert: true, new: true, session });
                await Transaction.create([{ userId: referral.referrerId, driverId: referral.referrerId, amount, type: 'referral_reward', status: 'successful', idempotencyKey: key, reference: String(referral._id), description: 'Verified driver referral reward' }], { session });
            }
            await Referral.updateMany({ referredUserId: userId, status: 'pending' }, { $set: { status: 'successful', reward: existing?.amount ?? amount, rewardedAt: new Date() } }, { session });
        });
    } finally { await session.endSession(); }
}
async function trySettleReferral(userId) {
    try { await settleReferral(userId); }
    catch { console.error('Referral reward is pending; settlement can be retried.'); }
}
async function getSummary(userId, page = 1) {
    const user = await User.findById(userId).select('referralCode role');
    if (!user) throw new Error('User not found');
    // No referred user's phone, identity documents, or full name is exposed.
    const [records, total, pending, successful, paid] = await Promise.all([
        Referral.find({ referrerId: userId }).select('status reward createdAt rewardedAt').sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).lean(),
        Referral.countDocuments({ referrerId: userId }),
        Referral.countDocuments({ referrerId: userId, status: 'pending' }),
        Referral.countDocuments({ referrerId: userId, status: 'successful' }),
        Transaction.find({ driverId: userId, type: 'referral_reward', status: 'successful' }).select('amount').lean(),
    ]);
    return { code: user.referralCode || null, cashRewardsEligible: ['driver', 'agent'].includes(user.role), currentReward: Number(await configService.getConfig('referral_reward_amount', 5000)), total, pending, successful, totalEarned: paid.reduce((sum, row) => sum + row.amount, 0), page, hasMore: page * 20 < total, records };
}
module.exports = { normalizeCode, rewardEligible, resolveReferral, recordReferral, settleReferral, trySettleReferral, getSummary };
