const mongoose = require("mongoose");

// One MOTA Kwimuka (house moving) request. Partner-first: the team quotes, then assigns a
// partner truck. No money moves through this record yet.
const STATUSES = ["requested", "visit_scheduled", "visited", "quoted", "accepted", "confirmed", "in_progress", "completed", "cancelled"];
const PLACE_TYPES = ["apartment", "house", "office", "shop", "other"];
const TRUCK_ACCESS = ["at_door", "short_walk", "long_walk"];
const HOME_SIZES = ["few_items", "studio", "one_bedroom", "two_bedroom", "three_bedroom", "four_plus", "office"];
const TIME_WINDOWS = ["morning", "afternoon", "evening", "any"];

const stop = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        address: { type: String, trim: true, default: "" },
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
        placeType: { type: String, enum: PLACE_TYPES, required: true },
        floor: { type: Number, min: 0, max: 60, default: 0 },
        hasElevator: { type: Boolean, default: false },
        truckAccess: { type: String, enum: TRUCK_ACCESS, required: true },
        landmark: { type: String, trim: true, default: "" },
        contactName: { type: String, trim: true, default: "" },
        contactPhone: { type: String, trim: true, default: "" },
    },
    { _id: false },
);

const moveRequestSchema = new mongoose.Schema(
    {
        ref: { type: String, required: true, unique: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        from: { type: stop, required: true },
        to: { type: stop, required: true },
        homeSize: { type: String, enum: HOME_SIZES, required: true },
        items: [{ _id: false, key: { type: String, required: true }, qty: { type: Number, min: 1, max: 200, required: true } }],
        photos: [{ type: String }],
        truckKey: { type: String, default: null },
        wantsVisit: { type: Boolean, default: false },
        visit: {
            preferredDate: { type: Date, default: null },
            timeWindow: { type: String, enum: TIME_WINDOWS, default: "any" },
            scheduledAt: { type: Date, default: null },
            notes: { type: String, default: "" },
        },
        moveDate: { type: Date, default: null },
        timeWindow: { type: String, enum: TIME_WINDOWS, default: "morning" },
        loaders: { type: Number, min: 0, max: 12, default: 2 },
        packing: { type: Boolean, default: false },
        assembly: { type: Boolean, default: false },
        notes: { type: String, trim: true, default: "" },
        contactPhone: { type: String, trim: true, required: true },
        estimate: { min: Number, max: Number, distanceKm: Number },
        quote: {
            amount: { type: Number, default: null },
            note: { type: String, default: "" },
            quotedAt: { type: Date, default: null },
            quotedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        },
        partner: {
            company: { type: String, default: "" },
            driverName: { type: String, default: "" },
            phone: { type: String, default: "" },
            plate: { type: String, default: "" },
        },
        status: { type: String, enum: STATUSES, default: "requested", index: true },
        statusHistory: [{ _id: false, status: String, at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, note: String }],
        cancelReason: { type: String, default: "" },
        // Lead tracking: where the customer came from (app, web, a campaign or a referral code).
        source: { type: String, trim: true, default: "app" },
        campaign: { type: String, trim: true, default: "" },
        staffNotes: { type: String, default: "" },
    },
    { timestamps: true },
);

moveRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.MoveRequest || mongoose.model("MoveRequest", moveRequestSchema);
module.exports.STATUSES = STATUSES;
module.exports.PLACE_TYPES = PLACE_TYPES;
module.exports.TRUCK_ACCESS = TRUCK_ACCESS;
module.exports.HOME_SIZES = HOME_SIZES;
module.exports.TIME_WINDOWS = TIME_WINDOWS;
