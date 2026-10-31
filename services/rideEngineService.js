const Ride = require("../models/Ride");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const SupportCase = require("../models/SupportCase");
const DriverKyc = require("../models/DriverKyc");
const walletService = require("./walletService");
const paymentService = require("./paymentService");
const auditService = require("./auditService");
const { sendSMS } = require("./smsService");
const systemSettingService = require("./systemSettingService");
const sseService = require("./sseService");
const notificationService = require("./notificationService");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { normalizeRwandaPhone } = require("../utils/rwandaPhone");

const DRIVER_ACTIVE = ["accepted", "approaching", "arrived", "start_requested", "in_progress", "stop_requested", "awaiting_payment"];
const MAX_PASSENGERS = { motor: 1, car: 4 };
const hashPin = (pin) => crypto.createHash("sha256").update(String(pin)).digest("hex");
const normalizeVehicleType = (value) => {
    const v = String(value || "motor").toLowerCase();
    if (["motor", "moto", "motorcycle"].includes(v)) return "motor";
    if (v === "car") return "car";
    throw new Error("vehicleType must be motor or car.");
};

function emitToUser(userId, event, payload) {
    try { require("./socketService").getIo().to(`user_${userId}`).emit(event, payload); }
    catch (_) { /* Socket server may not be initialized in tests. */ }
    // The mobile apps listen on SSE: the specific event plus a generic "rideUpdate".
    sseService.sendEventToUser(userId, event, payload);
    if (payload?.rideId && event !== "rideUpdate") sseService.sendEventToUser(userId, "rideUpdate", payload);
}

async function notifyUser(user, title, message, event, payload) {
    if (!user) return;
    await notificationService.createNotification(user._id, title, message, "in_app", payload);
    emitToUser(user._id, event, payload);
    const tasks = [
        sendSMS(user.phone, message, event),
        notificationService.sendPushNotification(user._id, title, message, { ...payload, event }),
    ];
    if (user.email) tasks.push(notificationService.sendEmail(user.email, title, message));
    await Promise.allSettled(tasks);
}

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
const estimateFare = async (pickup, destination, options = {}) => {
    if (!pickup?.latitude || !pickup?.longitude || !destination?.latitude || !destination?.longitude) {
        throw new Error("Both pickup and destination coordinates are required.");
    }
    const vehicleType = normalizeVehicleType(options.vehicleType);
    // Road distance (Google, else OpenStreetMap) when available; straight line otherwise.
    const route = await require("./routingService").getRoute(pickup, destination).catch(() => null);
    const distanceKm = route ? route.distanceMeters / 1000 : haversine(pickup.latitude, pickup.longitude, destination.latitude, destination.longitude);
    // Moto keeps the existing settings; cars use car_* settings (defaults below until an admin sets them).
    const car = vehicleType === "car";
    const prefix = car ? "car_" : "";
    const baseFare = await systemSettingService.getSetting(`${prefix}ride_base_fare`, car ? 1500 : 500);
    const perKmRate = await systemSettingService.getSetting(`${prefix}ride_per_km_rate`, car ? 500 : 300);
    const minFare = await systemSettingService.getSetting(`${prefix}ride_minimum_fare`, car ? 2500 : 500);
    const parcelSurcharge = options.rideType === "parcel" ? await systemSettingService.getSetting("parcel_surcharge", 300) : 0;
    const calculatedFare = baseFare + Math.round(distanceKm * perKmRate) + parcelSurcharge;
    const suggestedFare = Math.max(calculatedFare, minFare);
    const minimumFare = Math.round(suggestedFare * 0.8);
    const maximumFare = Math.round(suggestedFare * 1.2);
    const avgSpeedKmh = await systemSettingService.getSetting("ride_avg_speed_kmh", 20);
    const durationMinutes = route ? Math.max(1, Math.round(route.durationSeconds / 60)) : Math.round((distanceKm / avgSpeedKmh) * 60);
    return {
        vehicleType,
        distanceKm: Math.round(distanceKm * 10) / 10,
        durationMinutes,
        minimumFare,
        maximumFare,
        suggestedFare,
        routeSource: route ? route.source : "estimate",
        encodedPolyline: route?.encodedPolyline || null,
    };
};

/** Prices every vehicle type so the passenger can compare before choosing. */
const estimateOptions = async (pickup, destination, rideType = "ride") => Promise.all(
    ["motor", "car"].map((vehicleType) => estimateFare(pickup, destination, { vehicleType, rideType }))
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. RIDE REQUEST (Passenger-initiated)
// ═══════════════════════════════════════════════════════════════════════════

const requestRide = async (passengerId, pickup, destination, offeredFare, backupDrivers = 1, passengers = 1, paymentMethod = "momo", scheduledDate = null, scheduledTime = null, options = {}) => {
    // Validate coordinates
    if (!pickup?.latitude || !destination?.latitude) {
        throw new Error("Pickup and destination coordinates are required.");
    }
    const vehicleType = normalizeVehicleType(options.vehicleType);
    const rideType = options.rideType === "parcel" ? "parcel" : "ride";
    passengers = rideType === "parcel" ? 1 : Number(passengers);
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > MAX_PASSENGERS[vehicleType]) {
        throw new Error(vehicleType === "motor" ? "A moto ride takes one passenger." : "A car ride takes 1 to 4 passengers.");
    }
    if (!["cash", "momo", "wallet"].includes(paymentMethod)) throw new Error("paymentMethod must be cash, momo or wallet.");
    offeredFare = Number(offeredFare);
    if (!Number.isInteger(offeredFare)) throw new Error("Offer must be a whole number of RWF.");

    let parcel;
    let deliveryPin;
    if (rideType === "parcel") {
        const p = options.parcel || {};
        const recipientPhone = normalizeRwandaPhone(p.recipientPhone);
        if (!String(p.recipientName || "").trim() || !recipientPhone) throw new Error("Parcel deliveries need the recipient's name and a valid Rwandan phone number.");
        const size = ["small", "medium", "large"].includes(p.size) ? p.size : "small";
        if (vehicleType === "motor" && size === "large") throw new Error("Large parcels need a car.");
        deliveryPin = String(crypto.randomInt(1000, 10000));
        parcel = { recipientName: String(p.recipientName).trim().slice(0, 80), recipientPhone, description: String(p.description || "").slice(0, 200), size, deliveryPinHash: hashPin(deliveryPin) };
    }

    // Server-side fare validation — never trust the client
    const estimate = await estimateFare(pickup, destination, { vehicleType, rideType });
    if (offeredFare < estimate.minimumFare) {
        throw new Error(`Fare too low. Minimum: ${estimate.minimumFare} RWF`);
    }
    if (offeredFare > estimate.maximumFare) {
        throw new Error(`Fare too high. Maximum: ${estimate.maximumFare} RWF`);
    }
    if (paymentMethod === "wallet") {
        const passengerWallet = await walletService.getOrCreateWallet(passengerId);
        if (passengerWallet.balance < offeredFare) {
            const error = new Error(`Insufficient wallet balance. Required: ${offeredFare} RWF, Available: ${passengerWallet.balance} RWF`);
            error.code = "INSUFFICIENT_WALLET_BALANCE";
            throw error;
        }
    }

    // Check passenger doesn't have an active ride
    const activeRide = await Ride.findOne({
        passengerId,
        rideStatus: { $in: ["requested", "searching", ...DRIVER_ACTIVE] },
    });
    if (activeRide) {
        throw new Error("You already have an active ride. Complete or cancel it first.");
    }

    // Scheduled times are entered in Kigali local time (UTC+02:00).
    let scheduledAt = null;
    if (scheduledDate && scheduledTime) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduledTime)) throw new Error("Invalid scheduled ride date or time.");
        scheduledAt = new Date(`${scheduledDate}T${scheduledTime}:00+02:00`);
        if (Number.isNaN(scheduledAt.getTime())) throw new Error("Invalid scheduled ride date or time.");
        if (scheduledAt.getTime() <= Date.now() + 20 * 60 * 1000) throw new Error("Schedule a ride at least 20 minutes ahead.");
    }

    // Create ride
    const ride = await Ride.create({
        passengerId,
        pickup,
        destination,
        vehicleType,
        rideType,
        parcel,
        estimatedDistanceKm: estimate.distanceKm,
        estimatedDurationMin: estimate.durationMinutes,
        minimumFare: estimate.minimumFare,
        maximumFare: estimate.maximumFare,
        suggestedFare: estimate.suggestedFare,
        offeredFare,
        fare: offeredFare,
        backupDriverCount: Math.max(1, Math.min(5, backupDrivers)),
        passengers,
        paymentMethod,
        scheduledDate,
        scheduledTime,
        scheduledAt,
        rideStatus: scheduledAt ? "scheduled" : "requested",
        ridePin: generatePin(),
        requestedAt: new Date(),
    });

    if (parcel) {
        // The recipient confirms delivery with this code, so only they receive it.
        const sender = await User.findById(passengerId).select("firstName");
        await sendSMS(parcel.recipientPhone, `MOTA: ${sender?.firstName || "Someone"} is sending you a parcel. Give the rider code ${deliveryPin} only when you receive it.`, "parcel_delivery_code");
    }

    if (scheduledAt) return { ride: { _id: ride._id, rideStatus: ride.rideStatus, scheduledAt, offeredFare: ride.offeredFare } };

    return dispatchRide(ride);
};

const offerPayload = async (ride, driver) => {
    const pickupLat = ride.pickup.lat || ride.pickup.latitude, pickupLng = ride.pickup.lng || ride.pickup.longitude;
    const pickupDist = driver?.lastLocation?.latitude != null ? haversine(driver.lastLocation.latitude, driver.lastLocation.longitude, pickupLat, pickupLng) : null;
    const fare = ride.fare ?? ride.offeredFare;
    const { commission, driverEarning } = await walletService.calculateCommission(fare);
    return {
        id: ride._id,
        rideId: ride._id,
        rideType: ride.rideType || "ride",
        vehicleType: ride.vehicleType || "motor",
        pickup: { address: ride.pickup.name || ride.pickup.address, distanceKm: pickupDist == null ? null : Math.round(pickupDist * 10) / 10 },
        destination: { address: ride.destination.name || ride.destination.address, distanceKm: Math.round((ride.estimatedDistanceKm || 0) * 10) / 10 },
        offeredFare: fare,
        maximumFare: ride.maximumFare,
        driverEarning,
        commissionAmount: commission,
        estimatedDurationMin: ride.estimatedDurationMin,
        paymentMethod: ride.paymentMethod,
        passengers: ride.passengers,
        parcel: ride.rideType === "parcel" ? { size: ride.parcel?.size, description: ride.parcel?.description } : undefined,
        scheduledDate: ride.scheduledDate,
        scheduledTime: ride.scheduledTime,
    };
};

const sendOffer = async (ride, driver) => {
    sseService.sendEventToUser(driver._id, "ride_request", await offerPayload(ride, driver));
    const what = ride.rideType === "parcel" ? "Parcel delivery" : "Ride request";
    const fare = ride.fare ?? ride.offeredFare;
    await notifyUser(driver, `Nearby ${what.toLowerCase()}`, `${what} near you. Offer: ${fare} RWF.`, "rideRequest", { rideId: ride._id, fare });
};

const dispatchRide = async (ride) => {
    const { pickup } = ride;
    const baseRadius = await systemSettingService.getSetting("ride_search_radius_km", 5);
    // Each dispatch round widens the search (up to 3x) and skips drivers already asked.
    const radius = Math.min(baseRadius * (1 + 0.5 * (ride.dispatchRound || 0)), baseRadius * 3);
    const nearbyDrivers = await findNearbyDrivers(
        pickup.lat || pickup.latitude, pickup.lng || pickup.longitude,
        radius,
        Math.max(1, Math.min(5, ride.backupDriverCount)),
        { vehicleType: ride.vehicleType || "motor", exclude: [...(ride.notifiedDrivers || []), ...(ride.declinedDrivers || []), ride.passengerId] }
    );
    await Ride.updateOne({ _id: ride._id }, { $set: { lastDispatchAt: new Date() }, $inc: { dispatchRound: 1 } });
    if (nearbyDrivers.length === 0) {
        await Ride.updateOne({ _id: ride._id, rideStatus: { $in: ["requested", "searching"] } }, { $set: { rideStatus: "searching" } });
        ride.rideStatus = "searching";
        return { ride, nearbyDrivers: [], requiresSupport: true };
    }
    const active = await Ride.findOneAndUpdate(
        { _id: ride._id, rideStatus: { $in: ["requested", "searching"] } },
        { $set: { rideStatus: "searching" }, $addToSet: { notifiedDrivers: { $each: nearbyDrivers.map(d => d._id) } } },
        { returnDocument: "after" }
    );
    if (!active) return { ride, nearbyDrivers: [], cancelled: true };
    ride.rideStatus = active.rideStatus;
    for (const driver of nearbyDrivers) {
        try { await sendOffer(active, driver); } catch (error) { console.error("Ride offer delivery failed:", error.message); }
    }
    return {
        ride: {
            _id: ride._id,
            rideStatus: ride.rideStatus,
            offeredFare: ride.offeredFare,
            estimatedDistanceKm: ride.estimatedDistanceKm,
            estimatedDurationMin: ride.estimatedDurationMin,
            driversNotified: nearbyDrivers.length,
        },
        nearbyDrivers,
    };
};

const processScheduledRides = async () => {
    const now = new Date();
    const reminderWindow = new Date(now.getTime() + 60 * 60 * 1000);
    const dispatchWindow = new Date(now.getTime() + 15 * 60 * 1000);

    // Atomic claims prevent duplicate reminders or driver dispatch in multi-instance deployments.
    while (true) {
        const ride = await Ride.findOneAndUpdate(
            { rideStatus: "scheduled", scheduledAt: { $lte: reminderWindow }, reminderSentAt: null },
            { $set: { reminderSentAt: now } }, { returnDocument: "after", sort: { scheduledAt: 1 } }
        );
        if (!ride) break;
        try {
            const passenger = await User.findById(ride.passengerId);
            await notifyUser(passenger, "Scheduled ride reminder", `Your MOTA ride is scheduled for ${ride.scheduledDate} at ${ride.scheduledTime}. Driver matching begins shortly before pickup.`, "scheduledRideReminder", { rideId: ride._id });
        } catch (error) { console.error("Scheduled ride reminder failed:", error); }
    }

    while (true) {
        const ride = await Ride.findOneAndUpdate(
            { rideStatus: "scheduled", scheduledAt: { $lte: dispatchWindow } },
            { $set: { rideStatus: "searching" } }, { returnDocument: "after", sort: { scheduledAt: 1 } }
        );
        if (!ride) break;
        try {
            await dispatchRide(ride);
            const passenger = await User.findById(ride.passengerId);
            await notifyUser(passenger, "Finding your scheduled driver", "MOTA is now looking for a driver for your scheduled ride.", "scheduledRideDispatch", { rideId: ride._id });
        } catch (error) {
            console.error("Scheduled ride dispatch failed:", error);
            await Ride.updateOne({ _id: ride._id, rideStatus: "searching", notifiedDrivers: { $size: 0 } }, { $set: { rideStatus: "scheduled" } });
            break;
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. FIND NEARBY DRIVERS
// ═══════════════════════════════════════════════════════════════════════════

const findNearbyDrivers = async (lat, lng, radiusKm = 5, limit = 3, filters = {}) => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const query = {
        role: "driver",
        isOnline: true,
        isActive: true,
        "lastLocation.latitude": { $exists: true },
        lastLocationAt: { $gte: fiveMinAgo },
    };
    const exclude = (filters.exclude || []).filter(Boolean).map(String);
    if (filters.vehicleType) {
        // Approved KYC records the vehicle as "moto" or "car".
        const kycType = filters.vehicleType === "car" ? "car" : "moto";
        const ids = await DriverKyc.distinct("userId", { status: "approved", vehicleType: kycType });
        query._id = { $in: ids.filter((id) => !exclude.includes(String(id))) };
    } else if (exclude.length) {
        query._id = { $nin: exclude };
    }
    const onlineDrivers = await User.find(query).select("_id phone firstName lastName lastLocation requestRadiusKm");
    const driversWithDistance = onlineDrivers
        .map(driver => ({
            ...driver.toObject(),
            distanceKm: haversine(lat, lng, driver.lastLocation.latitude, driver.lastLocation.longitude),
        }))
        // Respect each driver's own pickup-distance preference as well as the search radius.
        .filter(d => d.distanceKm <= radiusKm && (!d.requestRadiusKm || d.distanceKm <= d.requestRadiusKm))
        .sort((a, b) => a.distanceKm - b.distanceKm);
    // Drivers already on a trip are not offered new ones.
    const busy = new Set((await Ride.distinct("driverId", { driverId: { $in: driversWithDistance.map(d => d._id) }, rideStatus: { $in: DRIVER_ACTIVE } })).map(String));
    return driversWithDistance.filter(d => !busy.has(String(d._id))).slice(0, limit);
};

// ═══════════════════════════════════════════════════════════════════════════
// 4. DRIVER ACCEPT RIDE (Atomic lock)
// ═══════════════════════════════════════════════════════════════════════════

const acceptRide = async (driverId, rideId) => {
    const busy = await Ride.exists({ driverId, rideStatus: { $in: DRIVER_ACTIVE }, _id: { $ne: rideId } });
    if (busy) throw new Error("Finish your current ride before accepting another.");
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
                rideStatus: "approaching",
                acceptedAt: new Date(),
            },
        },
        { returnDocument: "after" }
    );

    if (!ride) {
        // Repeated accepts from the already assigned driver are idempotent. This
        // commonly happens when the request screen and timeline update together.
        const existing = await Ride.findById(rideId);
        if (!existing) throw new Error("Ride not found.");
        if (existing.driverId?.toString() === driverId.toString() && ["accepted", "approaching", "arrived", "start_requested", "in_progress", "stop_requested", "awaiting_payment"].includes(existing.rideStatus)) {
            return existing;
        }
        if (existing.rideStatus !== "searching") {
            throw new Error("This ride is assigned to another driver.");
        }
        throw new Error("You are not eligible for this ride.");
    }

    // Commission calculation
    const { commission, driverEarning } = await walletService.calculateCommission(ride.fare);
    ride.commissionAmount = commission;
    ride.driverEarning = driverEarning;
    await ride.save();
    closeOffers(ride, driverId);

    // Notify passenger
    const driver = await User.findById(driverId).select("firstName lastName phone");
    const passenger = await User.findById(ride.passengerId).select("phone email firstName");
    if (passenger) {
        await notifyUser(passenger, "Ride accepted", `Driver ${driver.firstName} accepted your ride. Fare: ${ride.fare} RWF.`, "rideAccepted", { rideId: ride._id, driverId, rideStatus: ride.rideStatus });
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

    // Keep the request open for other drivers and caller-support assignment.
    if (ride.declinedDrivers.length >= ride.notifiedDrivers.length) {
        const passenger = await User.findById(ride.passengerId).select("phone email firstName");
        if (passenger) {
            await notifyUser(passenger, "Still finding a driver", "The first nearby drivers declined, but your request remains active and support can assign another driver.", "rideStillSearching", { rideId: ride._id, rideStatus: ride.rideStatus });
        }
    }

    return { declined: true };
};

// ═══════════════════════════════════════════════════════════════════════════
// 6. DRIVER ARRIVED AT PICKUP
// ═══════════════════════════════════════════════════════════════════════════

const driverArrived = async (driverId, rideId) => {
    const ride = await Ride.findOne({ _id: rideId, driverId });
    if (!ride) throw new Error("No active ride found or you are not the assigned driver.");
    if (["arrived", "start_requested", "in_progress", "stop_requested", "awaiting_payment", "completed"].includes(ride.rideStatus)) return ride;
    if (!["accepted", "approaching"].includes(ride.rideStatus)) throw new Error(`Arrival cannot be confirmed while the ride status is ${ride.rideStatus}.`);
    const driver = await User.findById(driverId).select("lastLocation");
    const pickupLat = ride.pickup?.latitude ?? ride.pickup?.lat;
    const pickupLng = ride.pickup?.longitude ?? ride.pickup?.lng;
    if (!driver?.lastLocation?.latitude || !Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) throw new Error("A current driver GPS location is required to confirm arrival.");
    const distanceKm = haversine(driver.lastLocation.latitude, driver.lastLocation.longitude, pickupLat, pickupLng);
    if (distanceKm > 2) throw new Error(`You are ${distanceKm.toFixed(1)} km from the passenger. Arrival can be confirmed within 2 km.`);

    ride.rideStatus = "arrived";
    ride.arrivedAt = new Date();
    await ride.save();

    const passenger = await User.findById(ride.passengerId).select("phone email firstName");
    await notifyUser(passenger, "Driver arrived", "Your MOTA driver has arrived at the pickup point. Open the app and confirm only when you are together and ready to start.", "driverArrived", { rideId: ride._id, driverId, rideStatus: ride.rideStatus, arrivedAt: ride.arrivedAt });

    return ride;
};

const getDriverRequests = async (driverId) => {
    return Ride.find({
        rideStatus: "searching",
        notifiedDrivers: driverId,
        declinedDrivers: { $ne: driverId },
    }).select("pickup destination offeredFare estimatedDistanceKm estimatedDurationMin passengers scheduledDate scheduledTime requestedAt").sort({ requestedAt: -1 });
};

const requestStart = async (driverId, rideId) => {
    const current = await Ride.findOne({ _id: rideId, driverId });
    if (!current) throw new Error("Ride not found or you are not the assigned driver.");
    if (["start_requested", "in_progress", "stop_requested", "awaiting_payment", "completed"].includes(current.rideStatus)) return current;
    const ride = await Ride.findOneAndUpdate(
        { _id: rideId, driverId, rideStatus: "arrived" },
        { $set: { rideStatus: "start_requested", startRequestedAt: new Date() } },
        { returnDocument: "after" }
    );
    if (!ride) throw new Error("Ride must be at the pickup stage.");
    const passenger = await User.findById(ride.passengerId).select("phone email");
    await notifyUser(passenger, "Confirm ride start", "Your driver says you are together and ready. Open MOTA to confirm the ride start. The trip will not begin until you approve it.", "rideStartRequested", { rideId: ride._id, driverId, rideStatus: ride.rideStatus, startRequestedAt: ride.startRequestedAt });
    return ride;
};

const confirmStart = async (passengerId, rideId) => {
    const ride = await Ride.findOneAndUpdate(
        { _id: rideId, passengerId, rideStatus: "start_requested" },
        { $set: { rideStatus: "in_progress", startConfirmedAt: new Date(), startedAt: new Date() } },
        { returnDocument: "after" }
    );
    if (!ride) throw new Error("No start confirmation is pending.");
    emitToUser(ride.driverId, "rideStartConfirmed", { rideId: ride._id, rideStatus: ride.rideStatus });
    return ride;
};

const requestStop = async (driverId, rideId, deliveryPin) => {
    // Parcels finish only with the code the recipient got by SMS.
    const current = await Ride.findOne({ _id: rideId, driverId }).select("+parcel.deliveryPinHash rideType rideStatus");
    if (current?.rideType === "parcel" && current.rideStatus === "in_progress") {
        if (!deliveryPin || hashPin(deliveryPin) !== current.parcel?.deliveryPinHash) throw new Error("Enter the delivery code the recipient received by SMS.");
        await Ride.updateOne({ _id: rideId }, { $set: { "parcel.deliveredAt": new Date() } });
    }
    const ride = await Ride.findOneAndUpdate(
        { _id: rideId, driverId, rideStatus: "in_progress" },
        { $set: { rideStatus: "stop_requested", stopRequestedAt: new Date() } },
        { returnDocument: "after" }
    );
    if (!ride) throw new Error("No in-progress ride found.");
    const passenger = await User.findById(ride.passengerId).select("phone email");
    await notifyUser(passenger, "Confirm ride completion", "Your driver requested to end the ride. Confirm after reaching your destination.", "rideStopRequested", { rideId: ride._id, rideStatus: ride.rideStatus, fare: ride.fare });
    return ride;
};

const confirmStop = async (passengerId, rideId) => {
    const ride = await Ride.findOne({ _id: rideId, passengerId });
    if (!ride) throw new Error("Ride not found or you are not its passenger.");
    // A retry can arrive after the first request has already completed. Return
    // the current state instead of rejecting a successful confirmation.
    if (["awaiting_payment", "completed"].includes(ride.rideStatus)) return ride;
    if (ride.rideStatus !== "stop_requested") throw new Error(`The ride cannot be completed while its status is ${ride.rideStatus}. Wait for the driver to request the stop.`);
    ride.rideStatus = "awaiting_payment";
    ride.stopConfirmedAt = new Date();
    ride.actualDurationMin = Math.max(1, Math.round((Date.now() - new Date(ride.startedAt).getTime()) / 60000));
    if (ride.paymentMethod === "wallet" && ride.paymentStatus !== "successful") {
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                const { commission, driverEarning } = await walletService.calculateCommission(ride.fare);
                const passengerWallet = await Wallet.findOneAndUpdate({ driverId: passengerId, balance: { $gte: ride.fare } }, { $inc: { balance: -ride.fare } }, { returnDocument: "after", session });
                if (!passengerWallet) throw new Error("Insufficient wallet balance. Top up before completing payment.");
                await Wallet.findOneAndUpdate({ driverId: ride.driverId }, { $inc: { balance: driverEarning }, $setOnInsert: { driverId: ride.driverId } }, { upsert: true, returnDocument: "after", session });
                await Transaction.create([{ driverId: passengerId, rideId: ride._id, amount: -ride.fare, type: "ride_payment", status: "successful", description: `Wallet payment for ride ${ride._id}` }, { driverId: ride.driverId, rideId: ride._id, amount: driverEarning, feeAmount: commission, type: "ride_payment", status: "successful", description: `Ride earning after ${commission} RWF commission` }], { session, ordered: true });
                ride.paymentStatus = "successful";
                ride.commissionAmount = commission;
                ride.driverEarning = driverEarning;
                await ride.save({ session });
            });
        } finally { await session.endSession(); }
    } else {
        await ride.save();
    }
    emitToUser(ride.driverId, "rideStopConfirmed", { rideId: ride._id, rideStatus: ride.rideStatus, fare: ride.fare });
    return ride;
};

/**
 * The driver confirms the passenger paid cash. No wallet balance moves: the
 * driver already holds the fare. The platform commission is recorded as a
 * pending "commission" ledger row (owed by the driver) for finance to settle.
 * The conditional update makes retries a no-op.
 */
const recordCashCollected = async (ride) => {
    const { commission, driverEarning } = await walletService.calculateCommission(ride.fare);
    const session = await mongoose.startSession();
    let updated;
    try {
        await session.withTransaction(async () => {
            updated = await Ride.findOneAndUpdate(
                { _id: ride._id, paymentMethod: "cash", rideStatus: "awaiting_payment", paymentStatus: { $ne: "successful" } },
                { $set: { paymentStatus: "successful", commissionAmount: commission, driverEarning } },
                { returnDocument: "after", session }
            );
            if (!updated) return;
            await Transaction.create([{
                driverId: ride.driverId, rideId: ride._id, amount: -commission, type: "commission", status: "pending",
                description: `Commission owed on cash ride ${ride._id} (fare ${ride.fare} RWF collected in cash)`,
            }], { session });
        });
    } finally {
        await session.endSession();
    }
    return updated || Ride.findById(ride._id);
};

const claimFare = async (driverId, rideId) => {
    let ride = await Ride.findOne({ _id: rideId, driverId });
    if (!ride) throw new Error("Ride not found.");
    if (ride.paymentMethod === "cash" && ride.rideStatus === "awaiting_payment" && ride.paymentStatus !== "successful") {
        ride = await recordCashCollected(ride);
    }
    if (ride.paymentStatus !== "successful") throw new Error("Payment has not been confirmed yet.");
    if (!["awaiting_payment", "completed"].includes(ride.rideStatus)) throw new Error("Ride is not ready for fare claim.");
    if (ride.rideStatus !== "completed") {
        ride.rideStatus = "completed";
        ride.completedAt = new Date();
        ride.fareClaimedAt = new Date();
        await ride.save();
    }
    const wallet = await Wallet.findOne({ driverId });
    return { ride, balance: wallet?.balance || 0 };
};

const requestRidePayment = async (passengerId, rideId) => {
    const ride = await Ride.findOne({ _id: rideId, passengerId, rideStatus: "awaiting_payment" });
    if (!ride) throw new Error("Ride is not ready for passenger payment.");
    if (ride.paymentStatus === "successful") return { ref: ride.paypackRef, status: "successful" };
    if (ride.paypackRef) return { ref: ride.paypackRef, status: "pending" };
    const passenger = await User.findById(passengerId).select("phone");
    const result = await paymentService.requestCashIn(passenger.phone, ride.fare, process.env.PAYPACK_ENV || "development");
    if (!result.success) throw new Error("Payment provider could not start the request.");
    const ref = result.data?.ref;
    await Transaction.create({ driverId: ride.driverId, rideId: ride._id, amount: ride.fare, type: "cash_in", status: "pending", paypackRef: ref, description: `Passenger payment for ride ${ride._id}` });
    ride.paypackRef = ref;
    ride.paymentStatus = "pending";
    await ride.save();
    return { ref, status: "pending", amount: ride.fare };
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

    const cancellableStatuses = ["scheduled", "requested", "searching", "accepted", "approaching", "arrived", "start_requested", "in_progress"];
    if (!cancellableStatuses.includes(ride.rideStatus)) {
        throw new Error("This ride cannot be cancelled at its current stage.");
    }

    // Only passenger or assigned driver can cancel
    const isPassenger = ride.passengerId?.toString() === userId.toString();
    const isDriver = ride.driverId?.toString() === userId.toString();
    if (!isPassenger && !isDriver) {
        throw new Error("You are not authorized to cancel this ride.");
    }

    const startedCancellation = isPassenger && ride.rideStatus === "in_progress";
    if (startedCancellation && String(reason || "").trim().length < 10) {
        throw new Error("A clear cancellation or driver-report reason of at least 10 characters is required after the ride starts.");
    }

    if (startedCancellation && ride.paymentMethod === "wallet" && ride.paymentStatus !== "successful") {
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                const wallet = await Wallet.findOneAndUpdate(
                    { driverId: ride.passengerId, balance: { $gte: ride.fare } },
                    { $inc: { balance: -ride.fare, heldBalance: ride.fare } },
                    { returnDocument: "after", session }
                );
                if (!wallet) throw new Error("The ride fare cannot be placed on hold because the wallet balance is insufficient.");
                await Transaction.create([{ driverId: ride.passengerId, rideId: ride._id, amount: -ride.fare, type: "ride_payment", status: "pending", description: `Fare held for cancelled ride ${ride._id}` }], { session });
                ride.paymentStatus = "held";
                ride.heldAmount = ride.fare;
                await ride.save({ session });
            });
        } finally { await session.endSession(); }
    }

    if (["requested", "searching"].includes(ride.rideStatus)) closeOffers(ride);
    ride.rideStatus = "cancelled";
    ride.shareToken = undefined;
    ride.cancelledBy = userId;
    ride.cancellationReason = reason || "No reason provided";
    ride.cancelledAt = new Date();
    ride.cancellationRequiresReview = startedCancellation;
    if (startedCancellation) {
        const supportCase = await SupportCase.create({ customerId: ride.passengerId, driverId: ride.driverId, rideId: ride._id, category: "cancellation", subject: "Passenger cancelled an in-progress ride", description: ride.cancellationReason, priority: "high", status: "open", createdBy: userId, escalated: true });
        ride.supportCaseId = supportCase._id;
    }
    await ride.save();

    // Notify the other party
    // In-app + push + SMS to the other party (was SMS only).
    if (isPassenger && ride.driverId) {
        const driver = await User.findById(ride.driverId).select("phone email");
        await notifyUser(driver, "Ride cancelled", "The passenger cancelled the ride.", "rideCancelled", { rideId: ride._id, rideStatus: "cancelled" }).catch(() => {});
    } else if (isDriver && ride.passengerId) {
        const passenger = await User.findById(ride.passengerId).select("phone email");
        await notifyUser(passenger, "Driver cancelled", "Your driver cancelled the ride. Request again and MOTA will find another driver.", "rideCancelled", { rideId: ride._id, rideStatus: "cancelled" }).catch(() => {});
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
        .populate("driverId", "firstName lastName phone lastLocation lastLocationAt")
        .populate("passengerId", "firstName lastName phone");

    if (!ride) throw new Error("Ride not found.");

    // Don't expose exact passenger location to unassigned drivers
    const isPassenger = ride.passengerId?._id?.toString() === userId.toString();
    const isDriver = ride.driverId?._id?.toString() === userId.toString();

    if (!isPassenger && !isDriver) {
        // Check if they are a notified driver
        const isNotified = ride.notifiedDrivers.some(id => id.toString() === userId.toString());
        if (!isNotified) throw new Error("Not authorized to view this ride.");

        // Only drivers explicitly selected by the matching engine can view pickup coordinates.
        return {
            _id: ride._id,
            rideStatus: ride.rideStatus,
            offeredFare: ride.offeredFare,
            estimatedDistanceKm: ride.estimatedDistanceKm,
            estimatedDurationMin: ride.estimatedDurationMin,
            pickup: ride.pickup,
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
        rideStatus: { $in: ["accepted", "approaching", "arrived", "start_requested", "in_progress", "stop_requested", "awaiting_payment"] },
    }).populate("passengerId", "firstName lastName phone");
};

// ═══════════════════════════════════════════════════════════════════════════
// 14. DRIVER AVAILABILITY
// ═══════════════════════════════════════════════════════════════════════════

const setDriverAvailability = async (driverId, isOnline) => {
    const driver = await User.findById(driverId);
    if (!driver) throw new Error("Driver not found.");
    if (driver.role !== "driver") throw new Error("Only drivers can toggle availability.");
    if (isOnline) {
        const kyc = await DriverKyc.findOne({ userId: driverId, status: "approved" });
        if (!kyc) throw new Error("Approved driver documents are required before going online.");
        const expiryDates = [kyc.drivingLicenseExpiresAt, kyc.transportPermitExpiresAt, kyc.insuranceExpiresAt, kyc.vehicleRegistrationExpiresAt, kyc.technicalInspectionExpiresAt];
        if (expiryDates.some((date) => !date || date <= new Date())) throw new Error("A required driver document is missing an expiry date or has expired. Renew it before going online.");
    }

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
    const at = new Date();
    await User.findByIdAndUpdate(driverId, {
        lastLocation: { latitude, longitude, heading, speed },
        lastLocationAt: at,
    });
    // Stream the position to the passenger of the current trip.
    const live = await Ride.findOne({ driverId, rideStatus: { $in: ["accepted", "approaching", "arrived", "start_requested", "in_progress", "stop_requested"] } }).select("passengerId");
    if (live) sseService.sendEventToUser(live.passengerId, "driverLocation", { rideId: live._id, latitude, longitude, heading, at: at.toISOString() });
    const ride = await Ride.findOne({ driverId, rideStatus: "approaching", approachAlertSentAt: null });
    if (!ride) return;
    const pickupLat = ride.pickup?.latitude ?? ride.pickup?.lat; const pickupLng = ride.pickup?.longitude ?? ride.pickup?.lng;
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) return;
    const distanceKm = haversine(latitude, longitude, pickupLat, pickupLng);
    if (distanceKm >= 2 && distanceKm <= 10) {
        const passenger = await User.findById(ride.passengerId).select("phone email firstName");
        await notifyUser(passenger, "Driver approaching", `Your MOTA driver is ${distanceKm.toFixed(1)} km from the pickup point. Track the live movement in the app.`, "driverApproaching", { rideId: ride._id, driverId, rideStatus: ride.rideStatus, distanceKm: Number(distanceKm.toFixed(1)) });
        ride.approachAlertSentAt = new Date(); await ride.save();
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// 16. EXPIRE STALE RIDE REQUESTS
// ═══════════════════════════════════════════════════════════════════════════

/** Tell drivers who saw an offer that it is gone (taken, cancelled or expired). */
function closeOffers(ride, exceptDriverId) {
    for (const id of ride.notifiedDrivers || []) {
        if (exceptDriverId && String(id) === String(exceptDriverId)) continue;
        sseService.sendEventToUser(id, "ride_request_closed", { rideId: ride._id });
    }
}

/**
 * Background job (every 30 s): re-offer unanswered requests to more drivers,
 * then expire requests nobody accepted within RIDE_SEARCH_TIMEOUT_MINUTES.
 */
const expireStaleRequests = async (now = new Date()) => {
    const ttlMs = Number(process.env.RIDE_REQUEST_TTL_SECONDS || 60) * 1000;
    const stale = await Ride.find({ rideStatus: "searching", $or: [{ lastDispatchAt: { $lte: new Date(now - ttlMs) } }, { lastDispatchAt: null, requestedAt: { $lte: new Date(now - ttlMs) } }] }).limit(100);
    for (const ride of stale) {
        try { await dispatchRide(ride); } catch (error) { console.error("Re-dispatch failed:", error.message); }
    }
    const timeout = new Date(now - Number(process.env.RIDE_SEARCH_TIMEOUT_MINUTES || 10) * 60000);
    let expired = 0;
    while (true) {
        const ride = await Ride.findOneAndUpdate(
            { rideStatus: { $in: ["requested", "searching"] }, requestedAt: { $lte: timeout } },
            { $set: { rideStatus: "expired", expiredAt: now } },
            { returnDocument: "after" }
        );
        if (!ride) break;
        expired += 1;
        closeOffers(ride);
        const passenger = await User.findById(ride.passengerId).select("phone email firstName");
        await notifyUser(passenger, "No driver found", "No driver accepted in time. Try again, or raise your offer.", "rideExpired", { rideId: ride._id, rideStatus: "expired" }).catch(() => {});
    }
    await Ride.updateMany(
        { rideStatus: "searching", "counterOffers.status": "pending" },
        { $set: { "counterOffers.$[o].status": "expired" } },
        { arrayFilters: [{ "o.status": "pending", "o.createdAt": { $lte: new Date(now - 2 * ttlMs) } }] }
    );
    return expired;
};

module.exports = {
    recordCashCollected,
    estimateFare,
    estimateOptions,
    dispatchRide,
    sendOffer,
    closeOffers,
    notifyUser,
    normalizeVehicleType,
    hashPin,
    haversine,
    DRIVER_ACTIVE,
    requestRide,
    processScheduledRides,
    findNearbyDrivers,
    acceptRide,
    declineRide,
    driverArrived,
    getDriverRequests,
    requestStart,
    confirmStart,
    requestStop,
    confirmStop,
    claimFare,
    requestRidePayment,
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
