// Passenger-experience features layered on the ride engine: ride views for the
// app, active-ride restore, fare negotiation, tips, trip sharing, chat, calls
// and SOS to emergency contacts.
const crypto = require("crypto");
const mongoose = require("mongoose");
const Ride = require("../models/Ride");
const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const DriverKyc = require("../models/DriverKyc");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const Message = require("../models/Message");
const engine = require("./rideEngineService");
const walletService = require("./walletService");
const sseService = require("./sseService");
const { sendSMS } = require("./smsService");

const ACTIVE = ["requested", "searching", ...engine.DRIVER_ACTIVE];
const LIVE = ["accepted", "approaching", "arrived", "start_requested", "in_progress", "stop_requested", "awaiting_payment"];
const same = (a, b) => String(a?._id ?? a ?? "") === String(b?._id ?? b ?? "");
const httpError = (status, message) => Object.assign(new Error(message), { status });
const publicBaseUrl = () => (process.env.PUBLIC_BASE_URL || "https://mota-be-v1-0-0-1.onrender.com").replace(/\/+$/, "");

/** Average of the ratings a user received, from ride records. */
async function ratingFor(userId, asDriver) {
    const [row] = await Ride.aggregate([
        { $match: asDriver ? { driverId: new mongoose.Types.ObjectId(String(userId)), passengerRating: { $gte: 1 } } : { passengerId: new mongoose.Types.ObjectId(String(userId)), driverRating: { $gte: 1 } } },
        { $group: { _id: null, avg: { $avg: asDriver ? "$passengerRating" : "$driverRating" }, count: { $sum: 1 } } },
    ]);
    return { rating: row ? Math.round(row.avg * 10) / 10 : null, ratingCount: row?.count || 0 };
}

/** The ride as the app needs it, limited to what this viewer may see. */
async function rideView(rideDoc, viewerId) {
    const ride = rideDoc.toObject ? rideDoc.toObject() : rideDoc;
    const passengerId = ride.passengerId?._id || ride.passengerId;
    const driverId = ride.driverId?._id || ride.driverId;
    const isPassenger = same(passengerId, viewerId);
    const isDriver = same(driverId, viewerId);
    const live = LIVE.includes(ride.rideStatus);
    const view = {
        _id: ride._id,
        status: ride.rideStatus,
        rideStatus: ride.rideStatus,
        rideType: ride.rideType || "ride",
        vehicleType: ride.vehicleType || "motor",
        offeredFare: ride.offeredFare,
        fare: ride.fare,
        minimumFare: ride.minimumFare,
        maximumFare: ride.maximumFare,
        suggestedFare: ride.suggestedFare,
        tipAmount: ride.tipAmount || 0,
        passengers: ride.passengers,
        paymentMethod: ride.paymentMethod,
        paymentStatus: ride.paymentStatus,
        estimatedDistanceKm: ride.estimatedDistanceKm,
        estimatedDurationMin: ride.estimatedDurationMin,
        scheduledDate: ride.scheduledDate,
        scheduledTime: ride.scheduledTime,
        pickup: ride.pickup,
        destination: ride.destination,
        requestedAt: ride.requestedAt,
        acceptedAt: ride.acceptedAt,
        arrivedAt: ride.arrivedAt,
        startedAt: ride.startedAt,
        completedAt: ride.completedAt,
        cancelledAt: ride.cancelledAt,
        cancellationReason: ride.cancellationReason,
        passengerRating: ride.passengerRating,
        passengerComment: ride.passengerComment,
        driverRating: ride.driverRating,
        driverComment: ride.driverComment,
        createdAt: ride.createdAt,
    };
    if (isDriver) { view.driverEarning = ride.driverEarning; view.commissionAmount = ride.commissionAmount; }
    if (isPassenger) {
        view.counterOffers = (ride.counterOffers || []).filter((o) => o.status === "pending");
        // The passenger shows this PIN to the driver; the driver never receives it.
        if (["requested", "searching", "accepted", "approaching", "arrived", "start_requested"].includes(ride.rideStatus)) view.ridePin = ride.ridePin;
    }
    if (ride.rideType === "parcel" && ride.parcel) {
        view.parcel = { recipientName: ride.parcel.recipientName, recipientPhone: isPassenger ? ride.parcel.recipientPhone : undefined, description: ride.parcel.description, size: ride.parcel.size, deliveredAt: ride.parcel.deliveredAt };
    }
    if (driverId) {
        const [driver, profile, kyc, rating, totalRides] = await Promise.all([
            User.findById(driverId).select("firstName lastName phone avatarUrl lastLocation lastLocationAt"),
            DriverProfile.findOne({ driverId }).select("plateNumber cooperativeName"),
            DriverKyc.findOne({ userId: driverId, status: "approved" }).select("vehicleType"),
            ratingFor(driverId, true),
            Ride.countDocuments({ driverId, rideStatus: "completed" }),
        ]);
        if (driver) {
            view.driver = {
                _id: driver._id,
                firstName: driver.firstName,
                lastName: driver.lastName,
                avatarUrl: driver.avatarUrl,
                ...rating,
                totalRides,
                plate: profile?.plateNumber || "N/A",
                plateNumber: profile?.plateNumber,
                cooperativeName: profile?.cooperativeName,
                vehicleType: kyc?.vehicleType === "car" ? "car" : "motor",
                phone: (isPassenger || isDriver) && live ? driver.phone : undefined,
                lastLocation: live ? driver.lastLocation : undefined,
                lastLocationAt: live ? driver.lastLocationAt : undefined,
            };
            view.driverId = view.driver; // older screens read driverId
        }
    }
    if (passengerId && (isPassenger || isDriver)) {
        const [p, rating] = await Promise.all([User.findById(passengerId).select("firstName lastName phone avatarUrl"), ratingFor(passengerId, false)]);
        if (p) view.passenger = { _id: p._id, firstName: p.firstName, lastName: isPassenger ? p.lastName : undefined, avatarUrl: p.avatarUrl, rating: rating.rating, phone: live ? p.phone : undefined };
    }
    return view;
}

async function passengerActiveRide(passengerId) {
    const ride = await Ride.findOne({ passengerId, rideStatus: { $in: ACTIVE } }).sort({ createdAt: -1 });
    return ride ? rideView(ride, passengerId) : null;
}

// ─── Fare negotiation ────────────────────────────────────────────────────────
async function checkWallet(ride, userId, amount) {
    if (ride.paymentMethod !== "wallet") return;
    const wallet = await walletService.getOrCreateWallet(userId);
    if (wallet.balance < amount) throw httpError(402, "Your wallet balance is too low for this price.");
}

/** Passenger raises the offer while still searching; notified drivers get the new price and more drivers are asked. */
async function raiseOffer(passengerId, rideId, amount) {
    amount = Number(amount);
    const ride = await Ride.findOne({ _id: rideId, passengerId, rideStatus: "searching" });
    if (!ride) throw httpError(409, "You can only raise the offer while MOTA is still finding a driver.");
    if (!Number.isInteger(amount) || amount <= ride.fare || amount > ride.maximumFare) {
        throw httpError(400, `New offer must be more than ${ride.fare} and at most ${ride.maximumFare} RWF.`);
    }
    await checkWallet(ride, passengerId, amount);
    ride.fare = amount;
    ride.offeredFare = amount;
    ride.declinedDrivers = []; // a better price is worth re-offering
    await ride.save();
    const known = await User.find({ _id: { $in: ride.notifiedDrivers } }).select("_id phone email lastLocation");
    for (const driver of known) await engine.sendOffer(ride, driver).catch(() => {});
    const result = await engine.dispatchRide(ride);
    return { rideId: ride._id, fare: ride.fare, notifiedDrivers: known.length + (result.nearbyDrivers?.length || 0) };
}

/** Driver proposes a higher price instead of accepting the passenger's offer. */
async function counterOffer(driverId, rideId, amount) {
    amount = Number(amount);
    const ride = await Ride.findOne({ _id: rideId, rideStatus: "searching", notifiedDrivers: driverId });
    if (!ride) throw httpError(409, "This request is no longer open to you.");
    if (!Number.isInteger(amount) || amount <= ride.fare || amount > ride.maximumFare) {
        throw httpError(400, `Counter-offer must be above ${ride.fare} and at most ${ride.maximumFare} RWF.`);
    }
    const updated = await Ride.findOneAndUpdate(
        { _id: rideId, rideStatus: "searching", "counterOffers.driverId": { $ne: driverId } },
        { $push: { counterOffers: { driverId, amount } } },
        { returnDocument: "after" }
    );
    if (!updated) throw httpError(409, "You already sent a price for this ride.");
    const offer = updated.counterOffers.find((o) => same(o.driverId, driverId));
    const [driver, profile, rating] = await Promise.all([
        User.findById(driverId).select("firstName lastLocation"),
        DriverProfile.findOne({ driverId }).select("plateNumber"),
        ratingFor(driverId, true),
    ]);
    const distanceKm = driver?.lastLocation?.latitude != null
        ? Math.round(engine.haversine(driver.lastLocation.latitude, driver.lastLocation.longitude, ride.pickup.latitude ?? ride.pickup.lat, ride.pickup.longitude ?? ride.pickup.lng) * 10) / 10
        : null;
    const passenger = await User.findById(ride.passengerId).select("phone email");
    await engine.notifyUser(passenger, "New price offer", `${driver.firstName} can take you for ${amount} RWF.`, "counterOffer", {
        rideId: ride._id, offerId: offer._id, amount,
        driver: { firstName: driver.firstName, rating: rating.rating, plate: profile?.plateNumber, distanceKm },
    });
    return offer;
}

async function acceptCounterOffer(passengerId, rideId, offerId) {
    const ride = await Ride.findOne({ _id: rideId, passengerId, rideStatus: "searching" });
    const offer = ride?.counterOffers.id(offerId);
    if (!offer || offer.status !== "pending") throw httpError(409, "This price offer is no longer available.");
    await checkWallet(ride, passengerId, offer.amount);
    const busy = await Ride.exists({ driverId: offer.driverId, rideStatus: { $in: engine.DRIVER_ACTIVE } });
    if (busy) throw httpError(409, "That driver just took another ride.");
    const { commission, driverEarning } = await walletService.calculateCommission(offer.amount);
    const assigned = await Ride.findOneAndUpdate(
        { _id: rideId, rideStatus: "searching", driverId: null, counterOffers: { $elemMatch: { _id: offerId, status: "pending" } } },
        { $set: { driverId: offer.driverId, fare: offer.amount, offeredFare: offer.amount, rideStatus: "approaching", acceptedAt: new Date(), commissionAmount: commission, driverEarning, "counterOffers.$.status": "accepted" } },
        { returnDocument: "after" }
    );
    if (!assigned) throw httpError(409, "This ride was already assigned.");
    engine.closeOffers(assigned, offer.driverId);
    const driver = await User.findById(offer.driverId).select("phone email firstName");
    await engine.notifyUser(driver, "Your price was accepted", `The passenger accepted ${offer.amount} RWF. Head to the pickup.`, "rideAssigned", { rideId: assigned._id, rideStatus: assigned.rideStatus });
    return assigned;
}

// ─── Tips ────────────────────────────────────────────────────────────────────
async function tipDriver(passengerId, rideId, tip) {
    tip = Number(tip);
    if (!Number.isInteger(tip) || tip <= 0 || tip > 50000) throw httpError(400, "Tip must be a whole amount up to 50,000 RWF.");
    const session = await mongoose.startSession();
    let ride;
    try {
        await session.withTransaction(async () => {
            ride = await Ride.findOne({ _id: rideId, passengerId, rideStatus: "completed", driverId: { $ne: null } }).session(session);
            if (!ride) throw httpError(404, "Completed ride not found.");
            const wallet = await Wallet.findOneAndUpdate({ driverId: passengerId, balance: { $gte: tip } }, { $inc: { balance: -tip } }, { returnDocument: "after", session });
            if (!wallet) throw httpError(402, "Your wallet balance is too low for this tip.");
            await Wallet.updateOne({ driverId: ride.driverId }, { $inc: { balance: tip }, $setOnInsert: { driverId: ride.driverId } }, { upsert: true, session });
            await Transaction.create([
                { driverId: passengerId, rideId: ride._id, amount: -tip, type: "tip", status: "successful", description: "Tip for driver" },
                { driverId: ride.driverId, rideId: ride._id, amount: tip, type: "tip", status: "successful", description: "Tip from passenger" },
            ], { session, ordered: true });
            await Ride.updateOne({ _id: ride._id }, { $inc: { tipAmount: tip } }, { session });
        });
    } finally {
        await session.endSession();
    }
    const driver = await User.findById(ride.driverId).select("phone email");
    await engine.notifyUser(driver, "You got a tip", `A passenger tipped you ${tip} RWF.`, "walletUpdate", { rideId: ride._id }).catch(() => {});
}

// ─── Trip sharing & SOS ──────────────────────────────────────────────────────
async function createShareLink(passengerId, rideId) {
    const ride = await Ride.findOne({ _id: rideId, passengerId, rideStatus: { $in: ACTIVE } });
    if (!ride) throw httpError(409, "Only an active ride can be shared.");
    if (!ride.shareToken || !ride.shareExpiresAt || ride.shareExpiresAt < new Date()) {
        ride.shareToken = crypto.randomBytes(18).toString("base64url");
        ride.shareExpiresAt = new Date(Date.now() + 6 * 3600000);
        await ride.save();
    }
    return { token: ride.shareToken, url: `${publicBaseUrl()}/share/${ride.shareToken}`, expiresAt: ride.shareExpiresAt };
}

/** What someone with the link may see: no phone numbers, no PIN. Dies when the ride ends. */
async function publicTrip(token) {
    if (!token || token.length < 16) return null;
    const ride = await Ride.findOne({ shareToken: token, shareExpiresAt: { $gt: new Date() }, rideStatus: { $in: ACTIVE } });
    if (!ride) return null;
    const [passenger, driver, profile, kyc] = await Promise.all([
        User.findById(ride.passengerId).select("firstName"),
        ride.driverId ? User.findById(ride.driverId).select("firstName lastLocation lastLocationAt") : null,
        ride.driverId ? DriverProfile.findOne({ driverId: ride.driverId }).select("plateNumber") : null,
        ride.driverId ? DriverKyc.findOne({ userId: ride.driverId, status: "approved" }).select("vehicleType") : null,
    ]);
    return {
        passengerFirstName: passenger?.firstName,
        rideStatus: ride.rideStatus,
        pickup: { name: ride.pickup?.name || ride.pickup?.address },
        destination: { name: ride.destination?.name || ride.destination?.address },
        startedAt: ride.startedAt,
        driver: driver ? {
            firstName: driver.firstName,
            plate: profile?.plateNumber,
            vehicle: kyc?.vehicleType === "car" ? "Car" : "Moto",
            location: driver.lastLocation?.latitude != null ? { latitude: driver.lastLocation.latitude, longitude: driver.lastLocation.longitude, at: driver.lastLocationAt } : null,
        } : null,
        expiresAt: ride.shareExpiresAt,
    };
}

/** Texts every emergency contact a live tracking link and last location. Returns how many were sent. */
async function alertEmergencyContacts(user, ride, location) {
    const contacts = user.emergencyContacts?.length
        ? user.emergencyContacts
        : user.emergencyContactPhone ? [{ name: user.emergencyContactName, phone: user.emergencyContactPhone }] : [];
    let link = "";
    if (ride && same(ride.passengerId, user._id) && ACTIVE.includes(ride.rideStatus)) {
        link = (await createShareLink(user._id, ride._id)).url;
    }
    const where = Number.isFinite(location?.latitude) ? ` Last location: https://maps.google.com/?q=${location.latitude},${location.longitude}` : "";
    const results = await Promise.all(contacts.map((c) => sendSMS(c.phone, `MOTA SAFETY ALERT: ${user.firstName} ${user.lastName} pressed SOS during a ride.${link ? ` Track live: ${link}` : ""}${where} If you cannot reach them, call 112.`, "sos_alert")));
    return { contactsNotified: results.filter(Boolean).length, contactsAttempted: contacts.length, shareUrl: link || undefined };
}

// ─── Chat & calls ────────────────────────────────────────────────────────────
async function participantRide(rideId, userId, requireLive) {
    const ride = await Ride.findOne({ _id: rideId, $or: [{ passengerId: userId }, { driverId: userId }] });
    if (!ride || !ride.driverId) throw httpError(404, "Chat is available once a driver accepts the ride.");
    if (requireLive && !LIVE.includes(ride.rideStatus)) throw httpError(409, "Chat closes when the ride ends.");
    return ride;
}

async function listMessages(rideId, userId) {
    await participantRide(rideId, userId, false);
    await Message.updateMany({ rideId, senderId: { $ne: userId }, readAt: null }, { $set: { readAt: new Date() } });
    return Message.find({ rideId }).sort({ createdAt: 1 }).limit(200);
}

async function sendMessage(rideId, user, text) {
    const body = String(text || "").trim();
    if (!body) throw httpError(400, "Message is empty.");
    if (body.length > 500) throw httpError(400, "Messages are limited to 500 characters.");
    const ride = await participantRide(rideId, user._id, true);
    const message = await Message.create({ rideId, senderId: user._id, text: body });
    const recipientId = same(ride.passengerId, user._id) ? ride.driverId : ride.passengerId;
    sseService.sendEventToUser(recipientId, "chatMessage", { rideId: String(ride._id), message });
    const recipient = await User.findById(recipientId).select("phone email");
    // In-app + push only; a chat message is not worth an SMS.
    const notificationService = require("./notificationService");
    await notificationService.createNotification(recipientId, `Message from ${user.firstName}`, body.slice(0, 120), "in_app", { rideId: ride._id, event: "chatMessage" }).catch(() => {});
    await notificationService.sendPushNotification(recipient?._id, `Message from ${user.firstName}`, body.slice(0, 120), { rideId: String(ride._id), event: "chatMessage" }).catch(() => {});
    return message;
}

/** Number of the other party, only during a live ride. (Masked calling needs a voice provider.) */
async function callInfo(rideId, userId) {
    const ride = await participantRide(rideId, userId, true);
    const other = await User.findById(same(ride.passengerId, userId) ? ride.driverId : ride.passengerId).select("phone");
    return { mode: "direct", phone: other?.phone };
}

module.exports = {
    rideView,
    passengerActiveRide,
    raiseOffer,
    counterOffer,
    acceptCounterOffer,
    tipDriver,
    createShareLink,
    publicTrip,
    alertEmergencyContacts,
    listMessages,
    sendMessage,
    callInfo,
};
