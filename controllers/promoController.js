const mongoose = require("mongoose");
const Ride = require("../models/Ride");
const User = require("../models/User");
const configService = require("../services/configService");
const promoService = require("../services/promoService");

/** The amount a code would apply to, taken from stored data (never from the client). */
const amountFor = async ({ appliesTo, rideId, userId }) => {
    if (appliesTo === "ride") {
        const ride = mongoose.isValidObjectId(rideId) ? await Ride.findOne({ _id: rideId, passengerId: userId }).select("fare rideStatus paymentMethod") : null;
        // MoMo rides are paid while awaiting payment; wallet rides are charged at "Confirm arrival".
        const payable = ride && ((ride.paymentMethod === "momo" && ride.rideStatus === "awaiting_payment")
            || (ride.paymentMethod === "wallet" && ["stop_requested", "awaiting_payment"].includes(ride.rideStatus)));
        if (!payable) throw new promoService.PromoError("wrong_type");
        return ride.fare;
    }
    if (appliesTo === "registration_fee") {
        const user = await User.findById(userId).select("role");
        if (user?.role !== "driver") throw new promoService.PromoError("drivers_only");
        return Number(await configService.getConfig("registration_fee", 5000));
    }
    throw new promoService.PromoError("wrong_type");
};

/** POST /api/promos/preview { code, appliesTo, rideId? } → the discounted price; reserves nothing. */
const preview = async (req, res) => {
    try {
        const { code, appliesTo, rideId } = req.body || {};
        const amount = await amountFor({ appliesTo, rideId, userId: req.user.id });
        const q = await promoService.quote({ code, appliesTo, userId: req.user.id, amount });
        const percent = q.originalAmount > 0 ? Math.round((q.discount / q.originalAmount) * 100) : 0;
        res.status(200).json({ data: { code: q.promo.code, discount: q.discount, payAmount: q.payAmount, originalAmount: q.originalAmount, percent } });
    } catch (error) {
        if (error instanceof promoService.PromoError) return res.status(400).json({ reason: error.reason, message: error.message });
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = { preview, amountFor };
