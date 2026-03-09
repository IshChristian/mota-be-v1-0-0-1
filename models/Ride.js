const mongoose = require("mongoose");

const rideSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    fare: { type: Number, required: true, min: 0 },
    paymentMethod: {
        type: String,
        enum: ["cash", "momo"],
        required: true,
    },
    pickupLocation: { type: String },
    dropoffLocation: { type: String },
    distance: { type: Number },
    createdAt: { type: Date, default: Date.now },
});

rideSchema.index({ driverId: 1, createdAt: -1 });

const Ride = mongoose.model("Ride", rideSchema);

module.exports = Ride;
