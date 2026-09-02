const Ride = require("../models/Ride");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const walletService = require("./walletService");
const paymentService = require("./paymentService");
const auditService = require("./auditService");
const { sendSMS } = require("./smsService");
const systemSettingService = require("./systemSettingService");
const sseService = require("./sseService");

// ── Haversine distance (km) ────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Generate 4-digit ride PIN ──────────────────────────────────────────────
function generatePin() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FARE ESTIMATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Estimate fare based on pickup and destination coordinates.
 * The server is authoritative — frontend NEVER decides fare.
 */
const estimateFare = async (pickup, destination) => {
    if (!pickup?.latitude || !pickup?.longitude || !destination?.latitude || !destination?.longitude) {
        throw new Error("Both pickup and destination coordinates are required.");
    }

    const distanceKm = haversine(
        pickup.latitude, pickup.longitude,
        destination.latitude, destination.longitude
    );

    // Base fare + per-km rate (configurable via system settings)
    const baseFare = await systemSettingService.getSetting("ride_base_fare", 500);
    const perKmRate = await systemSettingService.getSetting("ride_per_km_rate", 300);
    const minFare = await systemSettingService.getSetting("ride_minimum_fare", 500);

    const calculatedFare = baseFare + Math.round(distanceKm * perKmRate);
    const suggestedFare = Math.max(calculatedFare, minFare);

    // Allow ±20% negotiation range
    const minimumFare = Math.round(suggestedFare * 0.8);
    const maximumFare = Math.round(suggestedFare * 1.2);

    // Rough duration estimate: avg 20 km/h in Kigali traffic
    const avgSpeedKmh = await systemSettingService.getSetting("ride_avg_speed_kmh", 20);
    const durationMinutes = Math.round((distanceKm / avgSpeedKmh) * 60);

    return {
        distanceKm: Math.round(distanceKm * 10) / 10,
        durationMinutes,
        minimumFare,
        maximumFare,
        suggestedFare,
    };
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. RIDE REQUEST (Passenger-initiated)
// ═══════════════════════════════════════════════════════════════════════════

const requestRide = async (passengerId, pickup, destination, offeredFare, backupDrivers = 1, passengers = 1, scheduledDate = null, scheduledTime = null) => {
    // Validate coordinates
    if (!pickup?.latitude || !destination?.latitude) {
        throw new Error("Pickup and destination coordinates are required.");
    }

    // Server-side fare validation — never trust the client
    const estimate = await estimateFare(pickup, destination);
    if (offeredFare < estimate.minimumFare) {
        throw new Error(`Fare too low. Minimum: ${estimate.minimumFare} RWF`);
    }
    if (offeredFare > estimate.maximumFare) {
        throw new Error(`Fare too high. Maximum: ${estimate.maximumFare} RWF`);
    }

    // Cap backup drivers
    const driverCount = Math.max(1, Math.min(5, backupDriverCount));

    // Check passenger doesn't have an active ride
    const activeRide = await Ride.findOne({
        passengerId,
        rideStatus: { $in: ["requested", "searching", "accepted", "approaching", "arrived", "in_progress"] },
    });
    if (activeRide) {
        throw new Error("You already have an active ride. Complete or cancel it first.");
    }

    // Expiry: 2 minutes for drivers to accept
    const expiryMinutes = await systemSettingService.getSetting("ride_request_expiry_minutes", 2);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Create ride
    const ride = await Ride.create({
        passengerId,
        pickup,
        destination,
        estimatedDistanceKm: estimate.distanceKm,
        estimatedDurationMin: estimate.durationMinutes,
        minimumFare: estimate.minimumFare,
        maximumFare: estimate.maximumFare,
        offeredFare,
        fare: offeredFare,
        backupDriverCount: Math.max(1, Math.min(5, backupDrivers)),
        passengers,
        scheduledDate,
        scheduledTime,
        rideStatus: "requested",
        ridePin: generatePin(),
        requestedAt: new Date(),
        expiresAt,
    });

    // Find nearby online drivers
    const nearbyDrivers = await findNearbyDrivers(
        pickup.lat || pickup.latitude, pickup.lng || pickup.longitude,
        await systemSettingService.getSetting("ride_search_radius_km", 5),
        Math.max(1, Math.min(5, backupDrivers))
    );

    if (nearbyDrivers.length === 0) {
        ride.rideStatus = "expired";
        await ride.save();
        throw new Error("No drivers available near your location. Please try again.");
    }

    // Mark as searching and record notified drivers
    ride.rideStatus = "searching";
    ride.notifiedDrivers = nearbyDrivers.map(d => d._id);
    await ride.save();

    // Notify drivers via SMS and SSE
    const expiresInSeconds = expiryMinutes * 60;
    
    for (const driver of nearbyDrivers) {
        const pickupDist = haversine(
            driver.lastLocation.latitude, driver.lastLocation.longitude,
            pickup.lat || pickup.latitude, pickup.lng || pickup.longitude
        );

        // SSE Payload
        const ssePayload = {
            id: ride._id,
            pickup: {
                address: pickup.name || pickup.address,
                distanceKm: Math.round(pickupDist * 10) / 10
            },
            destination: {
                address: destination.name || destination.address,
                distanceKm: Math.round(estimate.distanceKm * 10) / 10
            },
            offeredFare: offeredFare,
            passengers: passengers,
            scheduledDate: scheduledDate,
            scheduledTime: scheduledTime,
            expiresInSeconds: expiresInSeconds
        };

        // Send real-time SSE event
        sseService.sendEventToDriver(driver._id, "ride_request", ssePayload);

        // Optional SMS fallback
        await sendSMS(
            driver.phone,
            `MOTA RIDE: New ride request! Pickup: ${pickupDist.toFixed(1)}km away. Fare: ${offeredFare} RWF. Trip: ${estimate.distanceKm}km. Open the app to accept.`,
            "ride_request"
        );
    }

    return {
        ride: {
            _id: ride._id,
            rideStatus: ride.rideStatus,
            offeredFare: ride.offeredFare,
            estimatedDistanceKm: ride.estimatedDistanceKm,
            estimatedDurationMin: ride.estimatedDurationMin,
            driversNotified: nearbyDrivers.length,
            expiresAt: ride.expiresAt,
        },
    };
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. FIND NEARBY DRIVERS
// ═══════════════════════════════════════════════════════════════════════════

const findNearbyDrivers = async (lat, lng, radiusKm = 5, limit = 3) => {
    // Find online drivers with recent location (within 5 minutes)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    const onlineDrivers = await User.find({
        role: "driver",
        isOnline: true,
        isActive: true,
        "lastLocation.latitude": { $exists: true },
        lastLocationAt: { $gte: fiveMinAgo },
    }).select("_id phone firstName lastName lastLocation");

    // Filter by distance and sort nearest first
    const driversWithDistance = onlineDrivers
        .map(driver => ({
            ...driver.toObject(),
            distanceKm: haversine(lat, lng, driver.lastLocation.latitude, driver.lastLocation.longitude),
        }))
        .filter(d => d.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);

    // Exclude drivers who already have an active ride
    const available = [];
    for (const driver of driversWithDistance) {
        if (available.length >= limit) break;
        const hasActiveRide = await Ride.findOne({
            driverId: driver._id,
            rideStatus: { $in: ["accepted", "approaching", "arrived", "in_progress"] },
        });
        if (!hasActiveRide) available.push(driver);
    }

    return available;
};

// ═══════════════════════════════════════════════════════════════════════════
// 4. DRIVER ACCEPT RIDE (Atomic lock)
// ═══════════════════════════════════════════════════════════════════════════

const acceptRide = async (driverId, rideId) => {
    // Atomic: only the FIRST driver to match gets the ride
    const ride = await Ride.findOneAndUpdate(
        {
            _id: rideId,
            rideStatus: "searching",
            notifiedDrivers: driverId,
        },
        {
            $set: {
                driverId,
                rideStatus: "accepted",
                acceptedAt: new Date(),
            },
        },
        { new: true }
    );

    if (!ride) {
        // Either already assigned or ride expired
        const existing = await Ride.findById(rideId);
        if (!existing) throw new Error("Ride not found.");
        if (existing.rideStatus !== "searching") {
            throw new Error("This ride has already been assigned to another driver.");
        }
        throw new Error("You are not eligible for this ride.");
    }

    // Commission calculation
    const { commission, driverEarning } = await walletService.calculateCommission(ride.fare);
    ride.commissionAmount = commission;
    ride.driverEarning = driverEarning;
    await ride.save();

    // Notify passenger
    const driver = await User.findById(driverId).select("firstName lastName phone");
    const passenger = await User.findById(ride.passengerId).select("phone");
    if (passenger) {
        await sendSMS(
            passenger.phone,
            `MOTA: Driver ${driver.firstName} accepted your ride! Plate: check app. Fare: ${ride.fare} RWF. Your ride PIN: ${ride.ridePin}`,
            "ride_accepted"
        );
    }

    await auditService.log({
        actorId: driverId,
        actorRole: "driver",
        action: "loan_created", // reuse audit enum or add ride-specific ones
        targetType: "Ride",
        targetId: ride._id,
        metadata: { action: "ride_accepted", fare: ride.fare },
    });

    return ride;
};

// ═══════════════════════════════════════════════════════════════════════════
// 5. DRIVER DECLINE RIDE
// ═══════════════════════════════════════════════════════════════════════════

const declineRide = async (driverId, rideId) => {
    const ride = await Ride.findById(rideId);
    if (!ride) throw new Error("Ride not found.");
    if (!ride.notifiedDrivers.some(id => id.toString() === driverId.toString())) {
        throw new Error("You were not notified for this ride.");
    }

    ride.declinedDrivers.push(driverId);
    await ride.save();

    // If all notified drivers declined, expire the ride
    if (ride.declinedDrivers.length >= ride.notifiedDrivers.length) {
        ride.rideStatus = "expired";
        await ride.save();

        const passenger = await User.findById(ride.passengerId).select("phone");
        if (passenger) {
            await sendSMS(
                passenger.phone,
                "MOTA: No drivers accepted your ride. Please try again with a different fare or wait a moment.",
                "ride_expired"
            );
        }
    }

    return { declined: true };
};

// ═══════════════════════════════════════════════════════════════════════════
// 6. DRIVER ARRIVED AT PICKUP
// ═══════════════════════════════════════════════════════════════════════════

const driverArrived = async (driverId, rideId) => {
    const ride = await Ride.findOne({ _id: rideId, driverId, rideStatus: { $in: ["accepted", "approaching"] } });
    if (!ride) throw new Error("No active ride found or you are not the assigned driver.");

    ride.rideStatus = "arrived";
    ride.arrivedAt = new Date();
    await ride.save();

    const passenger = await User.findById(ride.passengerId).select("phone");
    if (passenger) {
        await sendSMS(passenger.phone, "MOTA: Your driver has arrived at the pickup point!", "driver_arrived");
    }

    return ride;
};

// ═══════════════════════════════════════════════════════════════════════════
// 7. START RIDE (Requires passenger PIN)
// ═══════════════════════════════════════════════════════════════════════════

const startRide = async (driverId, rideId, pin) => {
    const ride = await Ride.findOne({ _id: rideId, driverId, rideStatus: "arrived" });
    if (!ride) throw new Error("Ride not found or not at pickup stage.");

    if (ride.ridePin && ride.ridePin !== pin) {
        throw new Error("Invalid ride PIN. Ask the passenger for the correct 4-digit code.");
    }

    ride.rideStatus = "in_progress";
    ride.startedAt = new Date();
    await ride.save();

    return ride;
};

// ═══════════════════════════════════════════════════════════════════════════
// 8. COMPLETE RIDE
// ═══════════════════════════════════════════════════════════════════════════

const completeRide = async (driverId, rideId) => {
    const ride = await Ride.findOne({ _id: rideId, driverId, rideStatus: "in_progress" });
    if (!ride) throw new Error("No in-progress ride found.");

    // Calculate actual duration
    const actualDuration = Math.round((Date.now() - new Date(ride.startedAt).getTime()) / 60000);

    ride.rideStatus = "completed";
    ride.completedAt = new Date();
    ride.actualDurationMin = actualDuration;
    ride.paymentStatus = "pending";
    await ride.save();

    // Record transaction
    await Transaction.create({
        driverId,
        rideId: ride._id,
        amount: ride.fare,
        type: "ride_payment",
        status: "pending",
        senderPhone: ride.passengerPhone,
        receiverPhone: "MOTA",
        description: `Ride completed. Fare: ${ride.fare} RWF. Driver earning: ${ride.driverEarning} RWF.`,
    });

    // Notify passenger to pay
    const passenger = await User.findById(ride.passengerId).select("phone");
    if (passenger) {
        await sendSMS(
            passenger.phone,
            `MOTA: Ride completed! Fare: ${ride.fare} RWF. Please complete payment via the app.`,
            "ride_completed"
        );
    }

    return ride;
};

// ═══════════════════════════════════════════════════════════════════════════
// 9. CANCEL RIDE
// ═══════════════════════════════════════════════════════════════════════════

const cancelRide = async (userId, rideId, reason) => {
    const ride = await Ride.findById(rideId);
    if (!ride) throw new Error("Ride not found.");

    const cancellableStatuses = ["requested", "searching", "accepted", "approaching", "arrived"];
    if (!cancellableStatuses.includes(ride.rideStatus)) {
        throw new Error("This ride cannot be cancelled at its current stage.");
    }

    // Only passenger or assigned driver can cancel
    const isPassenger = ride.passengerId?.toString() === userId.toString();
    const isDriver = ride.driverId?.toString() === userId.toString();
    if (!isPassenger && !isDriver) {
        throw new Error("You are not authorized to cancel this ride.");
    }

    ride.rideStatus = "cancelled";
    ride.cancelledBy = userId;
    ride.cancellationReason = reason || "No reason provided";
    ride.cancelledAt = new Date();
    await ride.save();

    // Notify the other party
    if (isPassenger && ride.driverId) {
        const driver = await User.findById(ride.driverId).select("phone");
        if (driver) {
            await sendSMS(driver.phone, "MOTA: The passenger cancelled the ride.", "ride_cancelled");
        }
    } else if (isDriver && ride.passengerId) {
        const passenger = await User.findById(ride.passengerId).select("phone");
        if (passenger) {
            await sendSMS(passenger.phone, "MOTA: Your driver cancelled the ride. We're finding another driver.", "ride_cancelled");
        }
    }

    return ride;
};

// ═══════════════════════════════════════════════════════════════════════════
// 10. RATE RIDE
// ═══════════════════════════════════════════════════════════════════════════

const rateRide = async (userId, rideId, rating, comment) => {
    if (rating < 1 || rating > 5) throw new Error("Rating must be between 1 and 5.");

    const ride = await Ride.findById(rideId);
    if (!ride) throw new Error("Ride not found.");
    if (ride.rideStatus !== "completed") throw new Error("Can only rate completed rides.");

    const isPassenger = ride.passengerId?.toString() === userId.toString();
    const isDriver = ride.driverId?.toString() === userId.toString();

    if (isPassenger) {
        ride.passengerRating = rating;
        ride.passengerComment = comment;
    } else if (isDriver) {
        ride.driverRating = rating;
        ride.driverComment = comment;
    } else {
        throw new Error("You are not part of this ride.");
    }

    await ride.save();
    return ride;
};

// ═══════════════════════════════════════════════════════════════════════════
// 11. GET RIDE STATUS
// ═══════════════════════════════════════════════════════════════════════════

const getRideStatus = async (rideId, userId) => {
    const ride = await Ride.findById(rideId)
        .populate("driverId", "firstName lastName phone lastLocation")
        .populate("passengerId", "firstName lastName phone");

    if (!ride) throw new Error("Ride not found.");

    // Don't expose exact passenger location to unassigned drivers
    const isPassenger = ride.passengerId?._id?.toString() === userId.toString();
    const isDriver = ride.driverId?._id?.toString() === userId.toString();

    if (!isPassenger && !isDriver) {
        // Check if they are a notified driver
        const isNotified = ride.notifiedDrivers.some(id => id.toString() === userId.toString());
        if (!isNotified) throw new Error("Not authorized to view this ride.");

        // For notified-but-unassigned drivers: mask exact pickup
        return {
            _id: ride._id,
            rideStatus: ride.rideStatus,
            offeredFare: ride.offeredFare,
            estimatedDistanceKm: ride.estimatedDistanceKm,
            estimatedDurationMin: ride.estimatedDurationMin,
            pickupArea: ride.pickup?.address || "Nearby",
            destination: ride.destination,
            expiresAt: ride.expiresAt,
        };
    }

    return ride;
};

// ═══════════════════════════════════════════════════════════════════════════
// 12. PASSENGER RIDE HISTORY
// ═══════════════════════════════════════════════════════════════════════════

const getPassengerRides = async (passengerId, page = 1, limit = 20) => {
    const skip = (page - 1) * limit;
    const [rides, total] = await Promise.all([
        Ride.find({ passengerId })
            .populate("driverId", "firstName lastName phone")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Ride.countDocuments({ passengerId }),
    ]);
    return { rides, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ═══════════════════════════════════════════════════════════════════════════
// 13. DRIVER ACTIVE RIDE
// ═══════════════════════════════════════════════════════════════════════════

const getDriverActiveRide = async (driverId) => {
    return await Ride.findOne({
        driverId,
        rideStatus: { $in: ["accepted", "approaching", "arrived", "in_progress"] },
    }).populate("passengerId", "firstName lastName phone");
};

// ═══════════════════════════════════════════════════════════════════════════
// 14. DRIVER AVAILABILITY
// ═══════════════════════════════════════════════════════════════════════════

const setDriverAvailability = async (driverId, isOnline) => {
    const driver = await User.findById(driverId);
    if (!driver) throw new Error("Driver not found.");
    if (driver.role !== "driver") throw new Error("Only drivers can toggle availability.");

    // Cannot go offline while in an active ride
    if (!isOnline) {
        const activeRide = await Ride.findOne({
            driverId,
            rideStatus: { $in: ["accepted", "approaching", "arrived", "in_progress"] },
        });
        if (activeRide) {
            throw new Error("Cannot go offline while you have an active ride. Complete it first.");
        }
    }

    driver.isOnline = isOnline;
    await driver.save();

    return { isOnline: driver.isOnline };
};

// ═══════════════════════════════════════════════════════════════════════════
// 15. UPDATE DRIVER LOCATION
// ═══════════════════════════════════════════════════════════════════════════

const updateDriverLocation = async (driverId, latitude, longitude, heading, speed) => {
    await User.findByIdAndUpdate(driverId, {
        lastLocation: { latitude, longitude, heading, speed },
        lastLocationAt: new Date(),
    });
};

// ═══════════════════════════════════════════════════════════════════════════
// 16. EXPIRE STALE RIDE REQUESTS
// ═══════════════════════════════════════════════════════════════════════════

const expireStaleRequests = async () => {
    const result = await Ride.updateMany(
        {
            rideStatus: { $in: ["requested", "searching"] },
            expiresAt: { $lt: new Date() },
        },
        { $set: { rideStatus: "expired" } }
    );
    return result.modifiedCount;
};

module.exports = {
    estimateFare,
    requestRide,
    findNearbyDrivers,
    acceptRide,
    declineRide,
    driverArrived,
    startRide,
    completeRide,
    cancelRide,
    rateRide,
    getRideStatus,
    getPassengerRides,
    getDriverActiveRide,
    setDriverAvailability,
    updateDriverLocation,
    expireStaleRequests,
};
