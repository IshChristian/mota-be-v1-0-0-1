const Ride = require("../models/Ride");
const { updateStreak } = require("../services/streakService");
const { updateTier } = require("../services/tierService");

/**
 * Log a ride
 * POST /api/driver/log-ride
 */
const logRide = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { fare, paymentMethod, pickupLocation, dropoffLocation, distance } = req.body;

        if (!fare || !paymentMethod) {
            return res.status(400).json({ message: "fare and paymentMethod are required" });
        }

        if (!["cash", "momo"].includes(paymentMethod)) {
            return res.status(400).json({ message: "paymentMethod must be 'cash' or 'momo'" });
        }

        // Create ride
        const ride = await Ride.create({
            driverId,
            fare,
            paymentMethod,
            pickupLocation,
            dropoffLocation,
            distance,
        });

        // Update streak and tier
        const streakResult = await updateStreak(driverId);
        const tierResult = await updateTier(driverId);

        res.status(201).json({
            message: "Ride logged successfully",
            ride,
            ridesToday: streakResult.todayRideCount,
            target: 20,
            currentStreak: streakResult.currentStreak,
            tier: tierResult.tier,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get ride by ID
 * GET /api/ride/:id
 */
const getRideById = async (req, res) => {
    try {
        const ride = await Ride.findById(req.params.id).populate("driverId", "firstName lastName phone");

        if (!ride) {
            return res.status(404).json({ message: "Ride not found" });
        }

        res.status(200).json(ride);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    logRide,
    getRideById,
};
