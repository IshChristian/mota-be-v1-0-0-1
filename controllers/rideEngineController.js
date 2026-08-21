const rideEngineService = require("../services/rideEngineService");
const Ride = require("../models/Ride");

// ── PASSENGER ENDPOINTS ────────────────────────────────────────────────

/**
 * POST /api/rides/estimate
 * Estimate fare (no auth required — guests can use this)
 */
const estimateFare = async (req, res) => {
    try {
        const { pickup, destination } = req.body;
        const estimate = await rideEngineService.estimateFare(pickup, destination);
        res.status(200).json(estimate);
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
        const { pickup, destination, offeredFare, backupDriverCount } = req.body;

        if (!pickup || !destination || !offeredFare) {
            return res.status(400).json({ message: "pickup, destination, and offeredFare are required." });
        }

        const result = await rideEngineService.requestRide(
            passengerId, pickup, destination, offeredFare, backupDriverCount
        );
        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
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
        const { rating, comment } = req.body;
        if (!rating) return res.status(400).json({ message: "Rating is required (1-5)." });

        const ride = await rideEngineService.rateRide(req.user.id, req.params.id, rating, comment);
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
        const { issue, description } = req.body;
        // For now, just log it. Can be expanded to a support ticket system.
        res.status(200).json({ message: "Report submitted. Our team will review it.", rideId: req.params.id, issue });
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
        const ride = await Ride.findById(req.params.id)
            .populate("driverId", "firstName lastName phone")
            .populate("passengerId", "firstName lastName phone");

        if (!ride) return res.status(404).json({ message: "Ride not found" });
        res.status(200).json(ride);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── DRIVER AVAILABILITY ────────────────────────────────────────────────

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

module.exports = {
    estimateFare,
    requestRide,
    getMyRides,
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
};
