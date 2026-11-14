// Phone proven by payment: sign-up needs no SMS code; a successful MoMo payment from the
// registered number sets isVerified; loans and referrals keep requiring it.
const { test, before, after } = require("node:test");
process.env.FINANCIAL_WRITES_ENABLED = "true"; // ride MoMo payments sit behind the financial write guard
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack } = require("./harness");
const { load, makeDriver } = require("./fixtures");

let app, User, SmsLog, DriverKyc;
let seq = 0;
const nextPhone = () => `078${String(5000000 + ++seq).slice(-7)}`;
const nextNid = () => `11998800${String(10000000 + seq).slice(-8)}`;

before(async () => {
    app = await startStack();
    User = load("models/User.js");
    SmsLog = load("models/SmsLog.js");
    DriverKyc = load("models/DriverKyc.js");
});
after(stopStack);

const register = (extra = {}) => request(app).post("/api/auth/register").send({
    firstName: "Aline", lastName: "Uwase", phone: nextPhone(), nationalId: nextNid(),
    password: "Passw0rd!x", role: "client", ...extra,
});

// ─── Task 1: sign-up and driver gates ───────────────────────────────────────

test("register returns a session and the passenger can use it", async () => {
    const res = await register();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.token, "token returned");
    assert.equal(res.body.user.isActive, true);
    assert.equal(res.body.user.isVerified, false);
    const me = await request(app).get("/api/users/me").set("Authorization", `Bearer ${res.body.token}`);
    assert.equal(me.status, 200);
});

test("register sends no SMS", async () => {
    const phone = nextPhone();
    await register({ phone });
    const { normalizeRwPhone } = load("services/smsService.js");
    assert.equal(await SmsLog.countDocuments({ phone: normalizeRwPhone(phone) }), 0);
});

test("old app: verify-otp still verifies", async () => {
    const { generateOTPToken } = load("utils/jwt.js");
    const res = await register();
    const id = res.body.userId;
    await User.updateOne({ _id: id }, { otpToken: generateOTPToken(id, "123456") });
    const verify = await request(app).post("/api/auth/verify-otp").send({ userId: id, otp: "123456" });
    assert.equal(verify.status, 200);
    assert.equal((await User.findById(id).lean()).isVerified, true);
});

test("unverified driver with full KYC, paid fee and approval can go online", async () => {
    const { user } = await makeDriver({ online: false });
    await User.updateOne({ _id: user._id }, { isVerified: false });
    const fresh = await User.findById(user._id);
    const { assertDriverCanGoOnline } = load("services/driverOnlineEligibility.js");
    const kyc = await DriverKyc.findOne({ userId: user._id });
    assert.doesNotThrow(() => assertDriverCanGoOnline(fresh, kyc));
    const { setDriverAvailability } = load("services/rideEngineService.js");
    const result = await setDriverAvailability(String(user._id), true, true, fresh.tokenVersion);
    assert.equal(result.isOnline, true);
});

test("driver can pay registration without a verified phone", async () => {
    const res = await register({ role: "driver" });
    const id = res.body.userId;
    await DriverKyc.create({ userId: id, status: "submitted", nationalIdNumber: nextNid(), vehicleType: "moto", plateNumber: `RB${seq}X` }).catch(() => null);
    await DriverKyc.updateOne({ userId: id }, { status: "submitted" }, { upsert: true, strict: false });
    const pay = await request(app).post("/api/auth/pay-registration").send({ phone: (await User.findById(id)).phone });
    assert.notEqual(pay.status, 409, JSON.stringify(pay.body));
    assert.doesNotMatch(String(pay.body.message), /verify your phone/i);
});

// ─── Task 2: a successful payment from the registered number proves the phone ──

const crypto = require("crypto");
const { makePassenger } = require("./fixtures");
const { generateToken } = load("utils/jwt.js");
const bearer = (user) => ({ Authorization: `Bearer ${generateToken(user)}` });

let charged; // numbers Paypack was asked to collect from
let refSeq = 0;
const stubCollections = () => {
    charged = [];
    const paymentService = load("services/paymentService.js");
    paymentService.requestCashIn = async (phone) => { charged.push(phone); return { success: true, data: { ref: `ref-${++refSeq}-${Date.now()}` } }; };
};
const paypackHook = (ref, amount) => {
    process.env.PAYPACK_WEBHOOK_SECRET = "pp-secret";
    const raw = JSON.stringify({ data: { ref, status: "successful", amount, kind: "CASHIN" } });
    const sig = crypto.createHmac("sha256", "pp-secret").update(raw).digest("base64");
    return request(app).post("/api/payment/webhook").set("Content-Type", "application/json").set("x-paypack-signature", sig).send(raw);
};
const key = () => `k-${crypto.randomUUID().slice(0, 20)}`;
const cashIn = async (user, phone) => {
    const res = await request(app).post("/api/wallet/cash-in").set(bearer(user)).set("Idempotency-Key", key()).send({ amount: 500, phone });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.ref || res.body.data?.ref;
};
const unverifiedPassenger = async () => (await makePassenger({ phone: `+25078${String(7000000 + ++seq).slice(-7)}`, isVerified: false })).user;
const localForm = (phone) => `0${phone.slice(4)}`; // +250788… → 0788…

test("cash-in from the registered number verifies", async () => {
    stubCollections();
    const user = await unverifiedPassenger();
    const ref = await cashIn(user, localForm(user.phone));
    assert.equal((await paypackHook(ref, 500)).status, 200);
    assert.equal((await User.findById(user._id).lean()).isVerified, true);
});

test("cash-in from another number does not verify", async () => {
    stubCollections();
    const user = await unverifiedPassenger();
    const ref = await cashIn(user, "0788999111");
    await paypackHook(ref, 500);
    assert.equal((await User.findById(user._id).lean()).isVerified, false);
});

const awaitingRide = async (passenger) => {
    const Ride = load("models/Ride.js");
    const { user: driver } = await makeDriver({ online: false });
    const { insertedId } = await Ride.collection.insertOne({
        passengerId: passenger._id, driverId: driver._id, rideStatus: "awaiting_payment", paymentMethod: "momo",
        fare: 1500, paymentStatus: "pending", createdAt: new Date(), updatedAt: new Date(),
    });
    return insertedId;
};
const payRide = (passenger, rideId, phone) => request(app).post(`/api/rides/${rideId}/pay`).set(bearer(passenger)).send(phone ? { phone } : {});

test("ride paid from the passenger's number verifies the passenger", async () => {
    stubCollections();
    const passenger = await unverifiedPassenger();
    const rideId = await awaitingRide(passenger);
    const res = await payRide(passenger, rideId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await paypackHook(res.body.data.ref, 1500);
    assert.equal((await User.findById(passenger._id).lean()).isVerified, true);
});

test("ride paid from a typed other number does not verify the passenger", async () => {
    stubCollections();
    const passenger = await unverifiedPassenger();
    const rideId = await awaitingRide(passenger);
    const res = await payRide(passenger, rideId, "0788999222");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(load("services/smsService.js").normalizeRwPhone(charged[0]), "+250788999222");
    await paypackHook(res.body.data.ref, 1500);
    assert.equal((await User.findById(passenger._id).lean()).isVerified, false);
});

test("ride payment with an invalid number is refused", async () => {
    stubCollections();
    const passenger = await unverifiedPassenger();
    const rideId = await awaitingRide(passenger);
    const res = await payRide(passenger, rideId, "12345");
    assert.equal(res.status, 400);
    assert.equal(charged.length, 0);
});

const driverAwaitingFee = async () => {
    const res = await register({ role: "driver" });
    const id = res.body.userId;
    await DriverKyc.updateOne({ userId: id }, { status: "submitted" }, { upsert: true, strict: false });
    return User.findById(id);
};

test("registration fee from the registered number verifies; from another number it does not", async () => {
    stubCollections();
    const own = await driverAwaitingFee();
    const other = await driverAwaitingFee();
    const a = await request(app).post("/api/auth/pay-registration").send({ phone: own.phone });
    const b = await request(app).post("/api/auth/pay-registration").send({ phone: other.phone, payerPhone: "0788999333" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(load("services/smsService.js").normalizeRwPhone(charged[1]), "+250788999333");
    await paypackHook(a.body.ref, 5000);
    await paypackHook(b.body.ref, 5000);
    const ownAfter = await User.findById(own._id).lean();
    const otherAfter = await User.findById(other._id).lean();
    assert.equal(ownAfter.registrationPaid, true);
    assert.equal(ownAfter.isVerified, true);
    assert.equal(otherAfter.registrationPaid, true);
    assert.equal(otherAfter.isVerified, false);
});

test("redelivered success does not settle referrals twice", async () => {
    stubCollections();
    const referralService = load("services/referralService.js");
    const real = referralService.trySettleReferral;
    let calls = 0;
    referralService.trySettleReferral = async () => { calls++; };
    try {
        const user = await unverifiedPassenger();
        const ref = await cashIn(user, user.phone);
        await paypackHook(ref, 500);
        await paypackHook(ref, 500);
        assert.equal(calls, 1);
    } finally { referralService.trySettleReferral = real; }
});
