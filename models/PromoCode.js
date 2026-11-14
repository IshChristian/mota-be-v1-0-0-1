const mongoose = require("mongoose");

// An admin-made discount code. Counters move atomically in services/promoService.js.
const promoCodeSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, match: /^[A-Z0-9-]{3,20}$/ },
    appliesTo: { type: String, enum: ["ride", "registration_fee"], required: true },
    discountType: { type: String, enum: ["percent", "fixed"], required: true },
    value: { type: Number, required: true, min: 1 },
    maxDiscount: { type: Number, min: 1, default: null },   // cap for percent codes (RWF)
    minAmount: { type: Number, min: 0, default: null },     // the fare/fee must be at least this
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    maxUsers: { type: Number, min: 1, default: null },      // different people; null = no limit
    perUserLimit: { type: Number, min: 1, default: 1 },
    active: { type: Boolean, default: true },
    note: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    archivedAt: { type: Date, default: null },
    // People holding at least one reserved or redeemed use.
    usersCount: { type: Number, default: 0, min: 0 },
    reservedCount: { type: Number, default: 0, min: 0 },
    redeemedCount: { type: Number, default: 0, min: 0 },
    totalDiscount: { type: Number, default: 0, min: 0 },
    // MOTA's extra cost on rides: the part of the discount the commission didn't cover.
    subsidyTotal: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

module.exports = mongoose.model("PromoCode", promoCodeSchema);
