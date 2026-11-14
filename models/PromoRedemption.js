const mongoose = require("mongoose");

// One use of a promo code: reserved when a payment starts, redeemed when it succeeds,
// released when it fails (or, with no payment ref, after 30 minutes).
const promoRedemptionSchema = new mongoose.Schema({
    promoId: { type: mongoose.Schema.Types.ObjectId, ref: "PromoCode", required: true, index: true },
    code: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    appliesTo: { type: String, enum: ["ride", "registration_fee"], required: true },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride" },
    paymentRef: { type: String, index: true, sparse: true },
    method: { type: String, enum: ["momo", "wallet", "none"], required: true },
    originalAmount: { type: Number, required: true },
    discount: { type: Number, required: true },
    paidAmount: { type: Number, required: true },
    subsidy: { type: Number, default: 0 },
    status: { type: String, enum: ["reserved", "redeemed", "released"], default: "reserved", index: true },
    reservedAt: { type: Date, default: Date.now },
    redeemedAt: { type: Date },
    releasedAt: { type: Date },
});

promoRedemptionSchema.index({ promoId: 1, userId: 1, status: 1 });

module.exports = mongoose.model("PromoRedemption", promoRedemptionSchema);
