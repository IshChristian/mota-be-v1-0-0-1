const User = require("../models/User");
const referralService = require("./referralService");
const { normalizeRwPhone } = require("./smsService");

/** A Rwandan mobile number in +2507XXXXXXXX form, or null when it isn't one. */
const toRwandaPhone = (phone) => {
    const normalized = normalizeRwPhone(phone);
    return /^\+2507\d{8}$/.test(normalized) ? normalized : null;
};

/** Same phone whatever the stored form: 0788…, 788…, 250788…, +250788…. */
const samePhone = (a, b) => !!a && !!b && normalizeRwPhone(a) === normalizeRwPhone(b);

/**
 * A MoMo payment succeeded: the payer approved it with their PIN on `payerPhone`.
 * If that is the account's registered number, the phone is proven (isVerified).
 * @returns {Promise<boolean>} true only when this call flipped isVerified to true
 */
const markPhoneProvenByPayment = async (userId, payerPhone) => {
    if (!userId || !payerPhone) return false;
    const user = await User.findById(userId).select("phone isVerified");
    if (!user || user.isVerified || !samePhone(user.phone, payerPhone)) return false;
    // Atomic flip so a redelivered webhook can't settle referrals twice.
    const flipped = await User.findOneAndUpdate({ _id: userId, isVerified: { $ne: true } }, { $set: { isVerified: true } }, { returnDocument: "after" });
    if (!flipped) return false;
    await referralService.trySettleReferral(userId);
    return true;
};

module.exports = { toRwandaPhone, samePhone, markPhoneProvenByPayment };
