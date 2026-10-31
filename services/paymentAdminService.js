// Staff corrections to payment STATUS (e.g. the driver paid the registration fee
// in person, or a ride was settled outside the app). No wallet balance or ledger
// amount changes here: money movements go through the wallet adjustment flow.
// Every change needs a reason and is written to the audit log.
const mongoose = require("mongoose");
const User = require("../models/User");
const Ride = require("../models/Ride");
const auditService = require("./auditService");
const notificationService = require("./notificationService");
const sseService = require("./sseService");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const RIDE_PAYMENT_STATUSES = ["pending", "successful", "failed"];

function readReason(body) {
    const reason = String(body.reason || "").trim();
    if (reason.length < 5) throw httpError(400, "Give a reason of at least 5 characters (it is saved in the audit log).");
    return reason.slice(0, 500);
}

async function setRegistrationPayment(staff, userId, body, ip) {
    if (!mongoose.isValidObjectId(userId)) throw httpError(404, "User not found.");
    if (typeof body.paid !== "boolean") throw httpError(400, "paid must be true or false.");
    const reason = readReason(body);
    const user = await User.findById(userId).select("firstName role registrationPaid registrationPaypackRef");
    if (!user) throw httpError(404, "User not found.");
    if (user.role !== "driver") throw httpError(400, "Only drivers pay a registration fee.");
    const before = Boolean(user.registrationPaid);
    if (before === body.paid) return { message: "No change: the status was already set.", data: { registrationPaid: before } };
    user.registrationPaid = body.paid;
    await user.save();
    await auditService.log({ actorId: staff._id, actorRole: staff.role, action: "registration_payment_updated", targetType: "User", targetId: user._id, ipAddress: ip, metadata: { before: { registrationPaid: before }, after: { registrationPaid: body.paid }, reason, paypackRef: user.registrationPaypackRef } });
    await notificationService.createNotification(user._id, body.paid ? "Registration fee confirmed" : "Registration fee status changed",
        body.paid ? "MOTA confirmed your registration payment. Your account review continues." : "MOTA marked your registration fee as unpaid. Open the app to pay or contact support.",
        "in_app", { event: "accountUpdate" }).catch(() => {});
    return { message: `Registration fee marked ${body.paid ? "paid" : "unpaid"}.`, data: { registrationPaid: body.paid } };
}

async function setRidePayment(staff, rideId, body, ip) {
    if (!mongoose.isValidObjectId(rideId)) throw httpError(404, "Ride not found.");
    const status = String(body.paymentStatus || "");
    if (!RIDE_PAYMENT_STATUSES.includes(status)) throw httpError(400, `paymentStatus must be one of: ${RIDE_PAYMENT_STATUSES.join(", ")}.`);
    const reason = readReason(body);
    const ride = await Ride.findById(rideId).select("passengerId driverId rideStatus paymentStatus paymentMethod fare");
    if (!ride) throw httpError(404, "Ride not found.");
    if (!["awaiting_payment", "completed", "cancelled"].includes(ride.rideStatus)) {
        throw httpError(409, "Payment status can only be corrected once the trip has ended.");
    }
    const before = ride.paymentStatus;
    if (before === status) return { message: "No change: the status was already set.", data: { paymentStatus: before }, warnings: [] };
    ride.paymentStatus = status;
    await ride.save();
    const warnings = [];
    if (before === "successful" && ride.paymentMethod === "wallet") warnings.push("This ride was paid from the wallet. Changing the status does not refund it; use a wallet adjustment if money must move.");
    if (status === "successful" && ride.rideStatus === "awaiting_payment") warnings.push("The driver can now finish the trip in the app.");
    await auditService.log({ actorId: staff._id, actorRole: staff.role, action: "ride_payment_updated", targetType: "Ride", targetId: ride._id, ipAddress: ip, metadata: { before: { paymentStatus: before }, after: { paymentStatus: status }, reason, fare: ride.fare, paymentMethod: ride.paymentMethod } });
    const payload = { rideId: String(ride._id), paymentStatus: status, rideStatus: ride.rideStatus };
    for (const userId of [ride.passengerId, ride.driverId].filter(Boolean)) {
        sseService.sendEventToUser(userId, "paymentUpdate", payload);
        sseService.sendEventToUser(userId, "rideUpdate", payload);
    }
    return { message: `Ride payment marked ${status}.`, data: { paymentStatus: status }, warnings };
}

module.exports = { setRegistrationPayment, setRidePayment, RIDE_PAYMENT_STATUSES };
