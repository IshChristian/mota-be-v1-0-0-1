const mongoose = require("mongoose");

const rideSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    passengerPhone: {
        type: String,
        trim: true,
    },
    fare: { type: Number, required: true, min: 0 },
    commissionRate: { type: Number, default: 0.10 }, // 10%
    driverEarning: { type: Number },                 // fare after commission
    commissionAmount: { type: Number },              // platform cut
    paymentMethod: {
        type: String,
        enum: ["cash", "momo", "ussd", "wallet"],
        required: true,
    },
    paymentStatus: {
        type: String,
        enum: ["pending", "successful", "failed"],
        default: "pending",
    },
    paypackRef: {
        type: String,
    },
    pickupLocation: { type: String },
    dropoffLocation: { type: String },
    distance: { type: Number },
    createdAt: { type: Date, default: Date.now },
});

rideSchema.index({ driverId: 1, createdAt: -1 });

const Ride = mongoose.model("Ride", rideSchema);

module.exports = Ride;
