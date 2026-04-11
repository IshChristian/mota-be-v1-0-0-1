const Ride = require("../models/Ride");
const { updateStreak } = require("../services/streakService");
const { updateTier } = require("../services/tierService");
const walletService = require("../services/walletService");
const algorithmService = require("../services/algorithmService");

/**
 * Log a ride
 * POST /api/driver/log-ride  (also aliased: POST /api/ride/log)
 */
const logRide = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { fare, passengerPhone, paymentMethod, pickupLocation, dropoffLocation, distance } = req.body;

        // Default to momo if not specified to follow 'direct Cash-in' requirement
        const finalPaymentMethod = paymentMethod || "momo";

        if (!["momo", "wallet"].includes(finalPaymentMethod)) {
            // Deprecating/Removing direct cash rides for now as requested by 'direct Cash-in'
            return res.status(400).json({ message: "Only digital payments (momo) are supported for logging rides at this time." });
        }

        const { commission, driverEarning } = await walletService.calculateCommission(fare);
        const commissionRate = (commission / fare).toFixed(2);

        // Create ride
        const ride = await Ride.create({
            driverId,
            passengerPhone,
            fare,
            commissionRate: Number(commissionRate),
            commissionAmount: commission,
            driverEarning,
            paymentMethod: finalPaymentMethod,
            paymentStatus: "pending", // Always pending for digital cash-in flow
            pickupLocation,
            dropoffLocation,
            distance,
        });

        // Removed local Cash logic - forcing 'momo' direct initiation
        let walletBalance = null;
        let paypackResponse = null;

        if (finalPaymentMethod === "momo") {
            // Trigger Paypack Cashin
            const phoneToCharge = passengerPhone || req.user.phone; // Default to driver if no passenger phone
            const paymentService = require("../services/paymentService");
            const Transaction = require("../models/Transaction");

            const result = await paymentService.requestCashIn(
                phoneToCharge,
                fare,
                process.env.PAYPACK_ENV || "development"
            );

            if (result.success) {
                paypackResponse = result.data;
                // Record pending transaction
                // (Already calculated above)
                await Transaction.create({
                    driverId,
                    rideId: ride._id,
                    amount: fare,
                    type: "cash_in",
                    status: "pending",
                    paypackRef: result.data?.ref,
                    description: `Cash In via MoMo. Fare: ${fare} RWF, Driver earns: ${driverEarning} RWF`,
                });

                // Update ride with ref
                ride.paypackRef = result.data?.ref;
                await ride.save();
            }
        }

        // Update streak and tier
        const streakResult = await updateStreak(driverId);
        const tierResult = await updateTier(driverId);

        // Process through MOTA Algorithm Engine
        let algorithmResult = null;
        try {
            algorithmResult = await algorithmService.processRide(driverId);
        } catch (algoErr) {
            console.error("Algorithm engine error (non-blocking):", algoErr.message);
        }

        res.status(201).json({
            message: paymentMethod === "cash" ? "Cash In recorded successfully" : "Cash In initiated via MoMo. Complete on phone.",
            ride,
            paypackRef: paypackResponse?.ref,
            driverEarning,
            commission,
            walletBalance,
            ridesToday: streakResult.todayRideCount,
            target: 20,
            currentStreak: streakResult.currentStreak,
            tier: tierResult.tier,
            algorithm: algorithmResult ? {
                daily_rides: algorithmResult.daily_rides,
                monthly_rides: algorithmResult.monthly_rides,
                current_tier: algorithmResult.current_tier,
                streak_days: algorithmResult.streak_days,
                trophies: algorithmResult.trophies,
                features_unlocked: algorithmResult.features_unlocked,
                daily_earnings: algorithmResult.daily_earnings,
            } : null,
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
