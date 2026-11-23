const PromoCode = require("../models/PromoCode");
const PromoRedemption = require("../models/PromoRedemption");
const PromoHold = require("../models/PromoHold");

// All promo rules live here. The app only ever sends the code text; amounts are computed
// from the stored fare/fee. A use is reserved when a payment starts, redeemed when it
// succeeds and released when it fails, so limits hold under concurrency.

const STALE_MS = 30 * 60 * 1000;

const MESSAGES = {
    not_found: () => "This promo code doesn't exist.",
    inactive: () => "This promo code is switched off.",
    wrong_type: () => "This promo code isn't for this payment.",
    not_started: () => "This promo code isn't active yet.",
    expired: () => "This promo code has expired.",
    below_minimum: (p) => `This promo code needs a payment of at least ${p.minAmount} RWF.`,
    used_up: () => "This promo code has been used up.",
    already_used: () => "You've already used this promo code.",
    drivers_only: () => "Promo codes are for driver registration.",
};

class PromoError extends Error {
    constructor(reason, promo = {}) {
        super(MESSAGES[reason](promo));
        this.reason = reason;
        this.status = 400;
    }
}

const normalizeCode = (code) => String(code || "").trim().toUpperCase();

/** Whole RWF discount, never more than the amount. */
const discountFor = (promo, amount) => {
    if (promo.discountType === "free") return Math.max(0, amount);
    const raw = promo.discountType === "percent" ? Math.round((amount * promo.value) / 100) : promo.value;
    const capped = promo.discountType === "percent" && promo.maxDiscount ? Math.min(raw, promo.maxDiscount) : raw;
    return Math.max(0, Math.min(capped, amount));
};

// Percentage and fixed fee codes always leave the MoMo minimum to pay. Only a "free" code makes the fee free.
const FEE_MIN_PAY = 100;

/** The discount actually given: fee codes (except free ones) leave at least 100 RWF to pay. */
const effectiveDiscount = (promo, amount) => {
    const discount = discountFor(promo, amount);
    return promo.appliesTo === "registration_fee" && promo.discountType !== "free" ? Math.min(discount, Math.max(0, amount - FEE_MIN_PAY)) : discount;
};

const statusOf = (promo, now = new Date()) => {
    if (promo.archivedAt) return "archived";
    if (!promo.active) return "off";
    if (promo.endsAt && promo.endsAt <= now) return "expired";
    if (promo.startsAt && promo.startsAt > now) return "scheduled";
    // Every place is taken: no new person can use it.
    if (promo.maxUsers && promo.usersCount >= promo.maxUsers) return "used_up";
    return "active";
};

const activeUsesOf = async (promoId, userId, session) =>
    (await PromoHold.findOne({ promoId, userId }).session(session || null))?.count || 0;

/** Take one of this person's uses atomically; null when they have none left. */
const takeUse = async (promo, userId, session) => {
    const filter = { promoId: promo._id, userId, count: { $lt: promo.perUserLimit } };
    const opts = { returnDocument: "after", session };
    try {
        return await PromoHold.findOneAndUpdate(filter, { $inc: { count: 1 } }, { ...opts, upsert: true });
    } catch (error) {
        if (error.code !== 11000) throw error;
        // The hold exists and is full, or a simultaneous first tap created it: try once more without upsert.
        return PromoHold.findOneAndUpdate(filter, { $inc: { count: 1 } }, opts);
    }
};

/** Give a use back; returns the person's remaining count. */
const giveUseBack = async (promoId, userId, session) =>
    (await PromoHold.findOneAndUpdate({ promoId, userId, count: { $gt: 0 } }, { $inc: { count: -1 } }, { returnDocument: "after", session }))?.count ?? 0;

/** Checks everything except the concurrency-safe limit, which reserve() enforces atomically. */
const checkCode = async ({ code, appliesTo, userId, amount, session }) => {
    const promo = await PromoCode.findOne({ code: normalizeCode(code), archivedAt: null }).session(session || null);
    if (!promo) throw new PromoError("not_found");
    if (!promo.active) throw new PromoError("inactive", promo);
    if (promo.appliesTo !== appliesTo) throw new PromoError("wrong_type", promo);
    const now = new Date();
    if (promo.startsAt && promo.startsAt > now) throw new PromoError("not_started", promo);
    if (promo.endsAt && promo.endsAt <= now) throw new PromoError("expired", promo);
    if (promo.minAmount && amount < promo.minAmount) throw new PromoError("below_minimum", promo);
    const mine = await activeUsesOf(promo._id, userId, session);
    if (mine >= promo.perUserLimit) throw new PromoError("already_used", promo);
    if (mine === 0 && promo.maxUsers && promo.usersCount >= promo.maxUsers) throw new PromoError("used_up", promo);
    return { promo, mine };
};

/** Price preview: nothing is reserved. */
const quote = async ({ code, appliesTo, userId, amount }) => {
    await releaseStale();
    const { promo } = await checkCode({ code, appliesTo, userId, amount });
    const discount = effectiveDiscount(promo, amount);
    return { promo, discount, payAmount: amount - discount, originalAmount: amount };
};

/** Hold one use for this user (atomic against maxUsers). */
const reserve = async ({ code, appliesTo, userId, amount, rideId, method }, { session } = {}) => {
    if (!session) await releaseStale();
    const { promo } = await checkCode({ code, appliesTo, userId, amount, session });
    const hold = await takeUse(promo, userId, session);
    if (!hold) throw new PromoError("already_used", promo);
    if (hold.count === 1) {
        // This person's first use: they take a place only while places remain.
        const placeFilter = promo.maxUsers ? { $expr: { $lt: ["$usersCount", "$maxUsers"] } } : {};
        const taken = await PromoCode.findOneAndUpdate({ _id: promo._id, ...placeFilter }, { $inc: { usersCount: 1, reservedCount: 1 } }, { returnDocument: "after", session });
        if (!taken) {
            await giveUseBack(promo._id, userId, session);
            throw new PromoError("used_up", promo);
        }
    } else {
        await PromoCode.updateOne({ _id: promo._id }, { $inc: { reservedCount: 1 } }, { session });
    }
    const discount = effectiveDiscount(promo, amount);
    const [redemption] = await PromoRedemption.create([{
        promoId: promo._id, code: promo.code, userId, appliesTo, rideId, method,
        originalAmount: amount, discount, paidAmount: amount - discount, status: "reserved", reservedAt: new Date(),
    }], { session });
    return redemption;
};

const attachPaymentRef = async (redemptionId, ref) => {
    await PromoRedemption.updateOne({ _id: redemptionId }, { $set: { paymentRef: ref } });
};

/** reserved → redeemed. Idempotent: returns true only for the call that made the move. */
const redeem = async (redemptionId, { subsidy = 0, session } = {}) => {
    const done = await PromoRedemption.findOneAndUpdate(
        { _id: redemptionId, status: "reserved" },
        { $set: { status: "redeemed", redeemedAt: new Date(), subsidy: Math.max(0, Math.round(subsidy)) } },
        { returnDocument: "after", session },
    );
    if (!done) return false;
    await PromoCode.updateOne({ _id: done.promoId }, { $inc: { reservedCount: -1, redeemedCount: 1, totalDiscount: done.discount, subsidyTotal: done.subsidy } }, { session });
    return true;
};

/** reserved → released, freeing the person's place when it was their only use. */
const release = async (redemptionId, { session } = {}) => {
    const done = await PromoRedemption.findOneAndUpdate(
        { _id: redemptionId, status: "reserved" },
        { $set: { status: "released", releasedAt: new Date() } },
        { returnDocument: "after", session },
    );
    if (!done) return false;
    const stillHolds = await giveUseBack(done.promoId, done.userId, session);
    await PromoCode.updateOne({ _id: done.promoId }, { $inc: { reservedCount: -1, ...(stillHolds ? {} : { usersCount: -1 }) } }, { session });
    return true;
};

const releaseByPaymentRef = async (ref) => {
    if (!ref) return 0;
    const held = await PromoRedemption.find({ paymentRef: ref, status: "reserved" }).select("_id");
    let count = 0;
    for (const { _id } of held) if (await release(_id)) count++;
    return count;
};

/** Reservations that never got a payment ref are released after 30 minutes. */
const releaseStale = async (now = new Date()) => {
    const stale = await PromoRedemption.find({ status: "reserved", paymentRef: null, reservedAt: { $lt: new Date(now.getTime() - STALE_MS) } }).select("_id");
    let count = 0;
    for (const { _id } of stale) if (await release(_id)) count++;
    return count;
};

module.exports = { PromoError, MESSAGES, FEE_MIN_PAY, normalizeCode, discountFor, effectiveDiscount, statusOf, quote, reserve, attachPaymentRef, redeem, release, releaseByPaymentRef, releaseStale };
