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
        const { pickup, destination, offeredFare, backupDrivers, passengers, paymentMethod, scheduledDate, scheduledTime } = req.body;

        if (!pickup || !destination || !offeredFare) {
            return res.status(400).json({ status: "error", message: "pickup, destination, and offeredFare are required." });
        }

        const result = await rideEngineService.requestRide(
            passengerId, pickup, destination, offeredFare, backupDrivers || 3, passengers || 1, paymentMethod, scheduledDate, scheduledTime
        );

        // Required JSON response by specs
        res.status(201).json({
            status: "success",
            message: "Ride request broadcasted to nearby drivers",
            data: {
                rideId: result.ride._id,
                requiresSupport: result.requiresSupport === true,
                notifiedDrivers: result.nearbyDrivers?.length || 0
            }
        });
    } catch (error) {
        res.status(400).json({ status: "error", message: error.message });
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
    try { res.status(200).json({ data: await rideEngineService.requestStop(req.user.id, req.params.id) }); }
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
            .populate("driverId", "firstName lastName phone lastLocation lastLocationAt")
            .populate("passengerId", "firstName lastName phone");

        if (!ride) return res.status(404).json({ status: "error", message: "Ride not found" });
        
        // Map to exact spec structure
        const mappedRide = {
            _id: ride._id,
            status: ride.rideStatus,
            offeredFare: ride.offeredFare,
            passengers: ride.passengers,
            scheduledDate: ride.scheduledDate,
            scheduledTime: ride.scheduledTime,
            pickup: ride.pickup,
            destination: ride.destination,
        };

        if (ride.driverId) {
            mappedRide.driver = {
                _id: ride.driverId._id,
                firstName: ride.driverId.firstName,
                phone: ride.driverId.phone,
                plate: ride.driverId.plateNumber || "N/A",
                lastLocation: ride.driverId.lastLocation
            };
        }

        if (ride.passengerId) {
            mappedRide.passenger = {
                _id: ride.passengerId._id,
                firstName: ride.passengerId.firstName,
                phone: ride.passengerId.phone
            };
        }

        res.status(200).json({
            status: "success",
            data: {
                ride: mappedRide
            }
        });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
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
