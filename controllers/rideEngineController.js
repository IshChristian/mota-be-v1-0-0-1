const rideEngineService = require("../services/rideEngineService");
const Ride = require("../models/Ride");
const riderFeatures = require("../services/riderFeaturesService");

/** Errors from the feature service carry an HTTP status; ride-engine errors are client errors. */
const fail = (res, error, fallback = 400) => res.status(error.status || fallback).json({ message: error.message, ...(error.code ? { code: error.code } : {}) });

// ── PASSENGER ENDPOINTS ────────────────────────────────────────────────

/**
 * POST /api/rides/estimate
 * Estimate fare (no auth required — guests can use this)
 */
const estimateFare = async (req, res) => {
    try {
        const { pickup, destination, vehicleType, rideType } = req.body;
        if (vehicleType) return res.status(200).json(await rideEngineService.estimateFare(pickup, destination, { vehicleType, rideType }));
        // No vehicle chosen yet: price every option. Top-level fields stay the moto
        // estimate so older app versions keep working.
        const options = await rideEngineService.estimateOptions(pickup, destination, rideType);
        res.status(200).json({ ...options[0], options, data: { options } });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/request
 * Passenger requests a ride
 */
const requestRide = async (req, res) => {
    try {
        const passengerId = req.user.id;
        const { pickup, destination, offeredFare, backupDrivers, passengers, paymentMethod, scheduledDate, scheduledTime, vehicleType, rideType, parcel } = req.body;

        if (!pickup || !destination || !offeredFare) {
            return res.status(400).json({ status: "error", message: "pickup, destination, and offeredFare are required." });
        }

        const result = await rideEngineService.requestRide(
            passengerId, pickup, destination, offeredFare, backupDrivers || 3, passengers || 1, paymentMethod || "cash", scheduledDate, scheduledTime, { vehicleType, rideType, parcel }
        );

        // Required JSON response by specs
        res.status(201).json({
            status: "success",
            message: result.ride.rideStatus === "scheduled" ? "Ride scheduled. Driver matching begins shortly before pickup." : "Ride request broadcasted to nearby drivers",
            data: {
                rideId: result.ride._id,
                rideStatus: result.ride.rideStatus,
                scheduledAt: result.ride.scheduledAt,
                requiresSupport: result.requiresSupport === true,
                notifiedDrivers: result.nearbyDrivers?.length || 0
            }
        });
    } catch (error) {
        if (/already have an active ride/.test(error.message)) {
            const active = await Ride.findOne({ passengerId: req.user.id, rideStatus: { $in: ["requested", "searching", ...rideEngineService.DRIVER_ACTIVE] } }).select("_id rideStatus");
            return res.status(409).json({ status: "error", message: error.message, rideId: active?._id, rideStatus: active?.rideStatus });
        }
        const status = error.code === "INSUFFICIENT_WALLET_BALANCE" ? 402 : 400;
        res.status(status).json({ status: "error", message: error.message, ...(error.code ? { code: error.code } : {}) });
    }
};

/**
 * GET /api/rides/my-rides
 * Passenger ride history
 */
const getMyRides = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const result = await rideEngineService.getPassengerRides(req.user.id, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getDriverRequests = async (req, res) => {
    try { res.status(200).json({ data: await rideEngineService.getDriverRequests(req.user.id) }); }
    catch (error) { res.status(500).json({ message: error.message }); }
};

const requestStart = async (req, res) => {
    try { res.status(200).json({ data: await rideEngineService.requestStart(req.user.id, req.params.id) }); }
    catch (error) { res.status(400).json({ message: error.message }); }
};

const confirmStart = async (req, res) => {
    try { res.status(200).json({ data: await rideEngineService.confirmStart(req.user.id, req.params.id) }); }
    catch (error) { res.status(400).json({ message: error.message }); }
};

const requestStop = async (req, res) => {
    try { res.status(200).json({ data: await rideEngineService.requestStop(req.user.id, req.params.id, req.body?.deliveryPin) }); }
    catch (error) { res.status(400).json({ message: error.message }); }
};

const confirmStop = async (req, res) => {
    try { res.status(200).json({ data: await rideEngineService.confirmStop(req.user.id, req.params.id) }); }
    catch (error) { res.status(400).json({ message: error.message }); }
};

const claimFare = async (req, res) => {
    try { res.status(200).json({ data: await rideEngineService.claimFare(req.user.id, req.params.id) }); }
    catch (error) { res.status(409).json({ message: error.message }); }
};

const requestRidePayment = async (req, res) => {
    try { res.status(200).json({ data: await rideEngineService.requestRidePayment(req.user.id, req.params.id) }); }
    catch (error) { res.status(409).json({ message: error.message }); }
};

// ── DRIVER ENDPOINTS ───────────────────────────────────────────────────

/**
 * POST /api/rides/:id/accept
 * Driver accepts a ride (atomic lock)
 */
const acceptRide = async (req, res) => {
    try {
        const ride = await rideEngineService.acceptRide(req.user.id, req.params.id);
        res.status(200).json({ message: "Ride accepted!", ride });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/:id/decline
 * Driver declines a ride
 */
const declineRide = async (req, res) => {
    try {
        const result = await rideEngineService.declineRide(req.user.id, req.params.id);
        res.status(200).json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/:id/arrived
 * Driver arrived at pickup
 */
const driverArrived = async (req, res) => {
    try {
        const ride = await rideEngineService.driverArrived(req.user.id, req.params.id);
        res.status(200).json({ message: "Arrived at pickup.", ride });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/:id/start
 * Start ride (requires passenger PIN)
 */
const startRide = async (req, res) => {
    try {
        const { pin } = req.body;
        if (!pin) return res.status(400).json({ message: "Ride PIN is required." });

        const ride = await rideEngineService.startRide(req.user.id, req.params.id, pin);
        res.status(200).json({ message: "Ride started!", ride });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/:id/complete
 * Complete ride
 */
const completeRide = async (req, res) => {
    try {
        const ride = await rideEngineService.completeRide(req.user.id, req.params.id);
        res.status(200).json({ message: "Ride completed!", ride });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/:id/cancel
 * Cancel ride (passenger or driver)
 */
const cancelRide = async (req, res) => {
    try {
        const { reason } = req.body;
        const ride = await rideEngineService.cancelRide(req.user.id, req.params.id, reason);
        res.status(200).json({ message: "Ride cancelled.", ride });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * GET /api/rides/:id/status
 * Get ride status
 */
const getRideStatus = async (req, res) => {
    try {
        const ride = await rideEngineService.getRideStatus(req.params.id, req.user.id);
        res.status(200).json(ride);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/:id/rating
 * Rate a completed ride
 */
const rateRide = async (req, res) => {
    try {
        const { rating, comment, tip } = req.body;
        if (!rating) return res.status(400).json({ message: "Rating is required (1-5)." });

        const ride = await rideEngineService.rateRide(req.user.id, req.params.id, Number(rating), comment);
        // Optional thank-you from the passenger's wallet.
        if (Number(tip) > 0 && String(ride.passengerId) === String(req.user.id)) {
            try { await riderFeatures.tipDriver(req.user.id, req.params.id, tip); }
            catch (error) { return res.status(200).json({ message: `Rating saved, but the tip failed: ${error.message}`, ride, tipError: error.message }); }
        }
        res.status(200).json({ message: "Rating submitted.", ride });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * POST /api/rides/:id/report
 * Report a problem with a ride
 */
const reportRide = async (req, res) => {
    try {
        const SupportCase = require("../models/SupportCase");
        const ride = await Ride.findOne({ _id: req.params.id, $or: [{ passengerId: req.user.id }, { driverId: req.user.id }] });
        if (!ride) return res.status(404).json({ message: "Ride not found." });
        const description = String(req.body.description || req.body.reason || req.body.issue || "").trim();
        if (description.length < 5) return res.status(400).json({ message: "Describe the problem in a few words." });
        const categories = ["ride_assignment", "acceptance_notification", "driver_arrival", "ride_start", "ride_stop", "payment", "cancellation", "other"];
        const supportCase = await SupportCase.create({
            customerId: ride.passengerId,
            driverId: ride.driverId,
            rideId: ride._id,
            category: categories.includes(req.body.category) ? req.body.category : "other",
            subject: String(req.body.issue || "Ride problem report").slice(0, 160),
            description: description.slice(0, 4000),
            priority: req.body.category === "payment" ? "high" : "normal",
            status: "open",
            createdBy: req.user.id,
        });
        res.status(201).json({ message: "Report submitted. Our team will review it.", rideId: req.params.id, data: { caseId: supportCase._id } });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/rides/:id
 * Get ride details by ID
 */
const getRideById = async (req, res) => {
    try {
        const ride = await Ride.findById(req.params.id);
        if (!ride) return res.status(404).json({ status: "error", message: "Ride not found" });
        const userId = req.user.id.toString();
        const allowed = String(ride.passengerId) === userId || String(ride.driverId) === userId || ride.notifiedDrivers.some((id) => id.toString() === userId);
        if (!allowed) return res.status(403).json({ status: "error", message: "Not authorized to view this ride." });
        res.status(200).json({ status: "success", data: { ride: await riderFeatures.rideView(ride, userId) } });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
};

// ── PASSENGER EXPERIENCE ───────────────────────────────────────────────

/** GET /api/rides/active — the passenger's current ride, so the app can restore it after a restart. */
const getPassengerActiveRide = async (req, res) => {
    try { res.status(200).json({ data: await riderFeatures.passengerActiveRide(req.user.id) }); }
    catch (error) { fail(res, error, 500); }
};
const raiseOffer = async (req, res) => {
    try { res.status(200).json({ data: await riderFeatures.raiseOffer(req.user.id, req.params.id, req.body.amount) }); }
    catch (error) { fail(res, error); }
};
const counterOffer = async (req, res) => {
    try { res.status(200).json({ data: await riderFeatures.counterOffer(req.user.id, req.params.id, req.body.amount) }); }
    catch (error) { fail(res, error); }
};
const acceptCounterOffer = async (req, res) => {
    try {
        const ride = await riderFeatures.acceptCounterOffer(req.user.id, req.params.id, req.params.offerId);
        res.status(200).json({ data: await riderFeatures.rideView(ride, req.user.id) });
    } catch (error) { fail(res, error); }
};
const shareRide = async (req, res) => {
    try { res.status(200).json({ data: await riderFeatures.createShareLink(req.user.id, req.params.id) }); }
    catch (error) { fail(res, error); }
};
const listMessages = async (req, res) => {
    try { res.status(200).json({ data: await riderFeatures.listMessages(req.params.id, req.user.id) }); }
    catch (error) { fail(res, error); }
};
const sendMessage = async (req, res) => {
    try { res.status(201).json({ data: await riderFeatures.sendMessage(req.params.id, req.user, req.body?.text) }); }
    catch (error) { fail(res, error); }
};
const callParty = async (req, res) => {
    try { res.status(200).json({ data: await riderFeatures.callInfo(req.params.id, req.user.id) }); }
    catch (error) { fail(res, error); }
};

/**
 * PUT /api/driver/availability
 * Toggle driver online/offline
 */
const setAvailability = async (req, res) => {
    try {
        const { isOnline } = req.body;
        if (typeof isOnline !== "boolean") {
            return res.status(400).json({ message: "isOnline (boolean) is required." });
        }
        const result = await rideEngineService.setDriverAvailability(req.user.id, isOnline);
        res.status(200).json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * GET /api/driver/active-ride
 * Get driver's current active ride
 */
const getActiveRide = async (req, res) => {
    try {
        const ride = await rideEngineService.getDriverActiveRide(req.user.id);
        if (!ride) return res.status(200).json({ activeRide: null });
        res.status(200).json({ activeRide: ride });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * PUT /api/driver/location
 * Update driver real-time GPS location via REST
 */
const updateLocation = async (req, res) => {
    try {
        const { latitude, longitude, heading, speed } = req.body;
        if (!latitude || !longitude) {
            return res.status(400).json({ status: "error", message: "latitude and longitude required" });
        }
        await rideEngineService.updateDriverLocation(req.user.id, latitude, longitude, heading, speed);
        res.status(200).json({
            status: "success",
            message: "Driver location updated"
        });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
};

module.exports = {
    getPassengerActiveRide,
    raiseOffer,
    counterOffer,
    acceptCounterOffer,
    shareRide,
    listMessages,
    sendMessage,
    callParty,
    estimateFare,
    requestRide,
    getMyRides,
    getDriverRequests,
    requestStart,
    confirmStart,
    requestStop,
    confirmStop,
    claimFare,
    requestRidePayment,
    acceptRide,
    declineRide,
    driverArrived,
    startRide,
    completeRide,
    cancelRide,
    getRideStatus,
    rateRide,
    reportRide,
    getRideById,
    setAvailability,
    getActiveRide,
    updateLocation,
};
