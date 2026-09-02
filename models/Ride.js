const mongoose = require("mongoose");

const rideSchema = new mongoose.Schema({
    // ── Actors ─────────────────────────────────────────────────────────
    passengerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        index: true,
    },
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        index: true,
    },
    passengerPhone: { type: String, trim: true },
    passengers: { type: Number, default: 1 },
    scheduledDate: { type: String },
    scheduledTime: { type: String },

    // ── Locations ──────────────────────────────────────────────────────
    pickup: {
        latitude: { type: Number },
        longitude: { type: Number },
        lat: { type: Number }, // Alias for latitude
        lng: { type: Number }, // Alias for longitude
        address: { type: String, trim: true },
        name: { type: String, trim: true },
    },
    destination: {
        latitude: { type: Number },
        longitude: { type: Number },
        lat: { type: Number },
        lng: { type: Number },
        address: { type: String, trim: true },
        name: { type: String, trim: true },
    },
    // Legacy string fields for backward compat with driver-logged rides
    pickupLocation: { type: String },
    dropoffLocation: { type: String },

    // ── Distance & Duration ────────────────────────────────────────────
    estimatedDistanceKm: { type: Number },
    estimatedDurationMin: { type: Number },
    actualDistanceKm: { type: Number },
    actualDurationMin: { type: Number },

    // ── Fare ───────────────────────────────────────────────────────────
    minimumFare: { type: Number },
    maximumFare: { type: Number },
    offeredFare: { type: Number },          // Passenger's fare offer
    fare: { type: Number, min: 0 },         // Final agreed fare
    commissionRate: { type: Number, default: 0.10 },
    commissionAmount: { type: Number },
    driverEarning: { type: Number },

    // ── Payment ────────────────────────────────────────────────────────
    paymentMethod: {
        type: String,
        enum: ["cash", "momo", "ussd", "wallet"],
    },
    paymentStatus: {
        type: String,
        enum: ["pending", "successful", "failed"],
        default: "pending",
    },
    paypackRef: { type: String },

    // ── Ride Lifecycle ─────────────────────────────────────────────────
    rideStatus: {
        type: String,
        enum: [
            "requested",      // Passenger submitted request
            "searching",      // Finding drivers (renamed from matching)
            "accepted",       // Driver accepted
            "approaching",    // Driver navigating to passenger (renamed from arriving)
            "arrived",        // Driver at pickup
            "in_progress",    // Ride started
            "completed",      // Ride finished
            "cancelled",      // Cancelled by either party
            "expired",        // No driver accepted in time
            "driver_logged",  // Legacy: driver-logged rides (backward compat)
        ],
        default: "driver_logged",
        index: true,
    },
    // The spec defines "status", so we alias it to rideStatus via a virtual later or just accept it as rideStatus in code but map to status in output
    status: { type: String },

    // ── Matching ───────────────────────────────────────────────────────
    backupDriverCount: { type: Number, default: 1, min: 1, max: 5 },
    notifiedDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    declinedDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // ── Ride PIN (OTP for passenger to confirm correct driver) ──────
    ridePin: { type: String },

    // ── Ratings ─────────────────────────────────────────────────────────
    passengerRating: { type: Number, min: 1, max: 5 },
    passengerComment: { type: String, trim: true },
    driverRating: { type: Number, min: 1, max: 5 },
    driverComment: { type: String, trim: true },

    // ── Cancellation ───────────────────────────────────────────────────
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cancellationReason: { type: String, trim: true },

    // ── Timestamps ─────────────────────────────────────────────────────
    requestedAt: { type: Date },
    matchedAt: { type: Date },
    acceptedAt: { type: Date },
    arrivedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
    expiresAt: { type: Date },

    // ── Distance & Duration for legacy rides ───────────────────────────
    distance: { type: Number },
    createdAt: { type: Date, default: Date.now },
});

rideSchema.index({ driverId: 1, createdAt: -1 });
rideSchema.index({ passengerId: 1, createdAt: -1 });
rideSchema.index({ rideStatus: 1, createdAt: -1 });
rideSchema.index({ "pickup.latitude": 1, "pickup.longitude": 1 });

const Ride = mongoose.model("Ride", rideSchema);

module.exports = Ride;
