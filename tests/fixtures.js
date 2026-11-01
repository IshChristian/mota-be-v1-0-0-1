const path = require("path");
const request = require("supertest");
const { ROOT } = require("./harness");
const load = (p) => require(path.join(ROOT, p));
const { generateToken } = load("utils/jwt.js");

let seq = 0;
const phone = () => `+25078${String(1000000 + ++seq).slice(-7)}`;

// Kigali: Kimihurura → Remera, ~2.3 km
const KIMIHURURA = { name: "Kimihurura", latitude: -1.9536, longitude: 30.0927 };
const REMERA = { name: "Remera", latitude: -1.9577, longitude: 30.1127 };

const auth = (user) => ({ Authorization: `Bearer ${generateToken(user)}` });

async function makePassenger(extra = {}) {
    const User = load("models/User.js");
    const user = await User.create({ firstName: "Aline", lastName: "Uwase", phone: phone(), role: "client", isVerified: true, isActive: true, registrationStatus: "approved", ...extra });
    return { user, auth: auth(user) };
}

async function makeDriver({ vehicleType = "moto", at = KIMIHURURA, online = true } = {}) {
    const User = load("models/User.js");
    const DriverKyc = load("models/DriverKyc.js");
    const DriverProfile = load("models/DriverProfile.js");
    const n = ++seq;
    const user = await User.create({
        firstName: "Jean", lastName: `Driver${n}`, phone: phone(), role: "driver", isVerified: true, isActive: true,
        registrationStatus: "approved", registrationPaid: true, kycLevel: "full", isOnline: online,
        lastLocation: { latitude: at.latitude + 0.003, longitude: at.longitude }, lastLocationAt: new Date(),
    });
    const doc = "https://res.cloudinary.com/test/doc.jpg";
    await DriverKyc.create({
        userId: user._id, nationalIdNumber: `11990800${n}`, nationalIdFront: doc, nationalIdBack: doc, selfie: doc,
        drivingLicenseNumber: `DL${n}`, drivingLicenseDocument: doc, transportPermitNumber: `TP${n}`, transportPermitDocument: doc,
        insuranceDocument: doc, vehicleRegistrationDocument: doc, technicalInspectionDocument: doc,
        plateNumber: `RA${n}C`, vehicleType, powertrain: "petrol", status: "approved",
    });
    await DriverProfile.create({ driverId: user._id, plateNumber: `RAB${100 + n}C`, nid: `NID${n}`, insuranceAttachment: doc, permitAttachment: doc, permitId: `P${n}` });
    return { user, auth: auth(user) };
}

async function fund(userId, balance) {
    const Wallet = load("models/Wallet.js");
    return Wallet.findOneAndUpdate({ driverId: userId }, { $set: { balance } }, { upsert: true, returnDocument: "after" });
}

async function requestRide(app, passenger, body = {}) {
    const vehicleType = ["motor", "car"].includes(body.vehicleType) ? body.vehicleType : "motor";
    const est = await request(app).post("/api/rides/estimate").send({ pickup: KIMIHURURA, destination: REMERA, vehicleType, rideType: body.rideType });
    return request(app).post("/api/rides/request").set(passenger.auth).send({
        pickup: KIMIHURURA, destination: REMERA, vehicleType: "motor", paymentMethod: "cash",
        offeredFare: est.body.suggestedFare, backupDrivers: 3, ...body,
    });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { load, makePassenger, makeDriver, fund, requestRide, wait, KIMIHURURA, REMERA };
