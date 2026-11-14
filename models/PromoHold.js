const mongoose = require("mongoose");

// How many uses (reserved or redeemed) one person holds on one code. Updated with single
// atomic operations so simultaneous taps by the same person can't double-count.
const promoHoldSchema = new mongoose.Schema({
    promoId: { type: mongoose.Schema.Types.ObjectId, ref: "PromoCode", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    count: { type: Number, default: 0, min: 0 },
});
promoHoldSchema.index({ promoId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model("PromoHold", promoHoldSchema);
