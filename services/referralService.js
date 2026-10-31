// Referrals. The reward is fixed when the invitee signs up; cash goes only to
// driver/agent referrers for driver invitees who are fully approved. Payment is
// one MongoDB transaction (wallet + ledger + referral status) keyed
// referral:<invitee>, so retries can never pay twice. Respects FINANCIAL_WRITES_ENABLED.
const mongoose = require("mongoose");
const Referral = require("../models/Referral");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const configService = require("./configService");

const CASH_REFERRERS = ["driver", "agent"];
const isCashReferral = (referrer, invitee) => CASH_REFERRERS.includes(referrer?.role) && invitee?.role === "driver";
const inviteeComplete = (u) => u && u.isVerified && (u.role !== "driver" || (u.kycLevel === "full" && u.registrationPaid && u.registrationStatus === "approved"));

/** Called at signup with the code the invitee typed. */
async function recordSignup(code, invitee) {
    const clean = String(code || "").trim().toUpperCase();
    if (!clean) return null;
    const referrer = await User.findOne({ referralCode: clean }).select("role phone");
    if (!referrer || String(referrer._id) === String(invitee._id)) return null;
    const reward = isCashReferral(referrer, invitee) ? Number(await configService.getConfig("referral_reward_amount", 5000)) || 0 : 0;
    return Referral.create({ referrerId: referrer._id, referredUserId: invitee._id, reward, status: "pending" });
}

/** Completes one referral if the invitee qualifies. Returns "paid" | "completed" | "waiting" | "already". */
async function settle(referralId) {
    const referral = await Referral.findById(referralId);
    if (!referral) return "missing";
    if (referral.status === "successful") return "already";
    const [referrer, invitee] = await Promise.all([User.findById(referral.referrerId).select("role"), User.findById(referral.referredUserId)]);
    if (!inviteeComplete(invitee)) return "waiting";
    const cash = isCashReferral(referrer, invitee) && referral.reward > 0;
    if (cash && process.env.FINANCIAL_WRITES_ENABLED !== "true") return "waiting";
    let outcome = "already";
    await mongoose.connection.transaction(async (session) => {
        const claimed = await Referral.findOneAndUpdate({ _id: referral._id, status: "pending" }, { $set: { status: "successful" } }, { returnDocument: "after", session });
        if (!claimed) return;
        if (cash) {
            await Wallet.updateOne({ driverId: referral.referrerId }, { $inc: { balance: referral.reward }, $setOnInsert: { driverId: referral.referrerId } }, { upsert: true, session });
            await Transaction.create([{ driverId: referral.referrerId, amount: referral.reward, type: "referral_reward", status: "successful", idempotencyKey: `referral:${referral.referredUserId}`, description: `Referral reward: ${referral.reward} RWF` }], { session });
        }
        outcome = cash ? "paid" : "completed";
    });
    return outcome;
}

/** Settles whatever referral points at this invitee (after verification/approval). Never throws. */
async function settleForInvitee(inviteeId) {
    try {
        const r = await Referral.findOne({ referredUserId: inviteeId, status: "pending" }).select("_id");
        return r ? await settle(r._id) : "none";
    } catch (error) {
        console.error("Referral settlement deferred:", error.message);
        return "error";
    }
}

async function mine(user, page = 1) {
    const limit = 20;
    const filter = { referrerId: user._id };
    const [records, total, pending, successful, earned, currentReward] = await Promise.all([
        Referral.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select("status reward createdAt").lean(),
        Referral.countDocuments(filter),
        Referral.countDocuments({ ...filter, status: "pending" }),
        Referral.countDocuments({ ...filter, status: "successful" }),
        Transaction.aggregate([{ $match: { driverId: user._id, type: "referral_reward", status: "successful" } }, { $group: { _id: null, s: { $sum: "$amount" } } }]),
        configService.getConfig("referral_reward_amount", 5000),
    ]);
    // Invitees' names/phones are never exposed.
    return {
        code: user.referralCode || null,
        cashRewardsEligible: CASH_REFERRERS.includes(user.role),
        currentReward: Number(currentReward) || 0,
        total, pending, successful,
        totalEarned: earned[0]?.s || 0,
        page,
        hasMore: page * limit < total,
        records,
    };
}

async function checkMine(user) {
    const pending = await Referral.find({ referrerId: user._id, status: "pending" }).limit(20).select("_id");
    const results = [];
    for (const r of pending) results.push(await settle(r._id));
    const paid = results.filter((r) => r === "paid").length;
    const completed = results.filter((r) => r === "completed").length;
    const waiting = results.filter((r) => r === "waiting").length;
    return { checked: pending.length, paid, completed, waiting, message: paid ? `${paid} reward${paid > 1 ? "s" : ""} added to your wallet.` : waiting ? "Your invitees haven't finished verification yet." : "No pending rewards." };
}

module.exports = { recordSignup, settle, settleForInvitee, mine, checkMine };
