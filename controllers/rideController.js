const Ride = require("../models/Ride");
const Transaction = require("../models/Transaction");
const walletService = require("../services/walletService");
const paymentService = require("../services/paymentService");
const { updateStreak } = require("../services/streakService");
const { updateTier } = require("../services/tierService");
const algorithmService = require("../services/algorithmService");

// ── Phone normalisation helper ────────────────────────────────────────────────
/**
 * Ensure phone starts with +250.
 * Accepts: +2507xxxxxxxx  |  07xxxxxxxx  |  7xxxxxxxx
 * Returns the normalised number or null if the format is invalid.
 */
function normalisePhone(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (/^\+250\d{9}$/.test(trimmed)) return trimmed;          // already correct
    if (/^07\d{8}$/.test(trimmed))    return `+250${trimmed.slice(1)}`; // 07xxxxxxxx
    if (/^7\d{8}$/.test(trimmed))     return `+250${trimmed}`;           // 7xxxxxxxx
    return null; // unrecognised format
}

/**
 * Log a ride
 * POST /api/driver/log-ride  (also aliased: POST /api/ride/log)
 *
 * Required body fields:
 *   - fare           {number}  — trip amount in RWF
 *   - passengerPhone {string}  — Rwandan number (+250 / 07 / 7 prefix)
 *
 * Optional:
 *   - paymentMethod  {string}  — "momo" (default) or "wallet"
 *   - date           {string}  — ISO date string (defaults to now)
 */
const logRide = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { fare, passengerPhone, paymentMethod, date } = req.body;

        // Default to momo; only momo is accepted for cash-in
        const finalPaymentMethod = paymentMethod || "momo";
        if (!["momo", "wallet"].includes(finalPaymentMethod)) {
            return res.status(400).json({ message: "Only 'momo' or 'wallet' payment methods are supported." });
        }

        // ── Validation ────────────────────────────────────────────────────────
        if (!fare || isNaN(Number(fare)) || Number(fare) <= 0) {
            return res.status(400).json({ message: "A valid fare amount (in RWF) is required." });
        }

        if (!passengerPhone) {
            return res.status(400).json({ message: "Passenger phone number is required." });
        }

        const normalisedPhone = normalisePhone(passengerPhone);
        if (!normalisedPhone) {
            return res.status(400).json({
                message:
                    "Invalid phone number. Must be a valid Rwandan number (e.g. +2507XXXXXXXX, 07XXXXXXXX, or 7XXXXXXXX).",
            });
        }

        const rideDate = date ? new Date(date) : new Date();
        if (isNaN(rideDate.getTime())) {
            return res.status(400).json({ message: "Invalid date format." });
        }

        // ── Commission calculation ────────────────────────────────────────────
        const numericFare = Number(fare);
        const { commission, driverEarning } = await walletService.calculateCommission(numericFare);
        const commissionRate = (commission / numericFare).toFixed(2);

        // ── Create ride (pending until Paypack webhook confirms) ─────────────
        const ride = await Ride.create({
            driverId,
            passengerPhone: normalisedPhone,
            fare: numericFare,
            commissionRate: Number(commissionRate),
            commissionAmount: commission,
            driverEarning,
            paymentMethod: finalPaymentMethod,
            paymentStatus: "pending",
            createdAt: rideDate,
        });

        // ── Trigger Paypack Cash-in ───────────────────────────────────────────
        let paypackRef = null;
        let paypackStatus = "not_initiated";

        try {
            const result = await paymentService.requestCashIn(
                normalisedPhone,
                numericFare,
                process.env.PAYPACK_ENV || "development"
            );

            if (result.success) {
                paypackRef = result.data?.ref;
                paypackStatus = "pending";

                // ── Record pending transaction (status = pending) ─────────────
                await Transaction.create({
                    driverId,
                    rideId: ride._id,
                    amount: numericFare,
                    type: "cash_in",
                    status: "pending",
                    paypackRef,
                    description: `Cash In via MoMo. Fare: ${numericFare} RWF, Driver earns: ${driverEarning} RWF`,
                });

                // Store ref on ride
                ride.paypackRef = paypackRef;
                await ride.save();
            } else {
                paypackStatus = "failed";
            }
        } catch (payErr) {
            console.error("Paypack initiation error (non-blocking):", payErr.message);
            paypackStatus = "error";
        }

        // ── Streak / tier / algorithm (non-blocking) ─────────────────────────
        let streakResult = null;
        let tierResult = null;
        let algorithmResult = null;

        try {
            streakResult = await updateStreak(driverId);
        } catch (e) {
            console.error("Streak update error (non-blocking):", e.message);
        }

        try {
            tierResult = await updateTier(driverId);
        } catch (e) {
            console.error("Tier update error (non-blocking):", e.message);
        }

        try {
            algorithmResult = await algorithmService.processRide(driverId);
        } catch (e) {
            console.error("Algorithm engine error (non-blocking):", e.message);
        }

        return res.status(201).json({
            message: "Ride logged. MoMo payment request sent to passenger's phone.",
            ride: {
                _id: ride._id,
                fare: ride.fare,
                passengerPhone: ride.passengerPhone,
                paymentStatus: ride.paymentStatus,   // "pending"
                paymentMethod: ride.paymentMethod,
                driverEarning,
                commission,
                createdAt: ride.createdAt,
            },
            paypackRef,
            paypackStatus,
            ridesToday: streakResult?.todayRideCount ?? null,
            target: 20,
            currentStreak: streakResult?.currentStreak ?? null,
            tier: tierResult?.tier ?? null,
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
