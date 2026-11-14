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
    const user = await User.findById(id);
    user.sessionToken = res.body.token;
    return user;
};

test("registration fee from the registered number verifies; from another number it does not", async () => {
    stubCollections();
    const own = await driverAwaitingFee();
    const other = await driverAwaitingFee();
    const a = await request(app).post("/api/auth/pay-registration").send({ phone: own.phone });
    const b = await request(app).post("/api/auth/pay-registration").set("Authorization", `Bearer ${other.sessionToken}`).send({ phone: other.phone, payerPhone: "0788999333" });
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

// ─── Task 3: phone changes reset proof; stuck passengers ─────────────────────

const adminPatch = async (target, body) => {
    const { user: owner } = await makePassenger({ role: "superadmin" });
    return request(app).patch(`/api/admin/users/${target._id}`).set(bearer(owner)).send(body);
};
const verifiedPassenger = async () => (await makePassenger({ phone: `+25078${String(7000000 + ++seq).slice(-7)}`, isVerified: true })).user;

test("admin phone edit resets verification", async () => {
    const user = await verifiedPassenger();
    const res = await adminPatch(user, { phone: `+25078${String(7000000 + ++seq).slice(-7)}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await User.findById(user._id).lean()).isVerified, false);
});

test("admin phone edit that switches isVerified on keeps it (staff verify by hand)", async () => {
    const user = await unverifiedPassenger();
    await adminPatch(user, { phone: `+25078${String(7000000 + ++seq).slice(-7)}`, isVerified: true });
    assert.equal((await User.findById(user._id).lean()).isVerified, true);
});

test("admin panel save (whole form, isVerified unchanged) with a new phone still resets", async () => {
    const user = await verifiedPassenger();
    await adminPatch(user, { phone: `+25078${String(7000000 + ++seq).slice(-7)}`, isVerified: true, isActive: true, firstName: user.firstName });
    assert.equal((await User.findById(user._id).lean()).isVerified, false);
});

test("admin edit that re-sends the same phone in another format keeps verification", async () => {
    const user = await verifiedPassenger();
    await adminPatch(user, { phone: localForm(user.phone), firstName: "Renamed" });
    assert.equal((await User.findById(user._id).lean()).isVerified, true);
});

test("contact change to a new phone resets verification", async () => {
    const user = await verifiedPassenger();
    const newPhone = `+25078${String(7000000 + ++seq).slice(-7)}`;
    await User.updateOne({ _id: user._id }, {
        pendingPhone: newPhone,
        contactChangeOtpHash: crypto.createHash("sha256").update("654321").digest("hex"),
        contactChangeExpiresAt: new Date(Date.now() + 60000),
    });
    const res = await request(app).post("/api/users/me/contact-change/verify").set(bearer(user)).send({ otp: "654321" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await User.findById(user._id).lean();
    assert.equal(after.phone, newPhone);
    assert.equal(after.isVerified, false);
});

test("stuck-passenger script activates only the intended accounts", async () => {
    const AuditLog = load("models/AuditLog.js");
    const { activateStuckPassengers } = load("services/stuckPassengerService.js");
    await User.deleteMany({ role: "client", isActive: false });
    const make = (extra) => User.create({ firstName: "S", lastName: "P", phone: `+25078${String(7000000 + ++seq).slice(-7)}`, role: "client", isVerified: false, isActive: false, createdAt: new Date("2026-05-01"), ...extra });
    const stuck = await make({});
    await make({ createdAt: new Date("2026-03-01") });
    await make({ isVerified: true });
    await make({ activationBlocked: true });
    await make({ deletedAt: new Date() });
    const disabled = await make({});
    await AuditLog.create({ action: "user_updated", targetType: "User", targetId: disabled._id, metadata: { changes: { isActive: false } } });

    const dry = await activateStuckPassengers({ dryRun: true });
    assert.deepEqual(dry, { matched: 1, activated: 0 });
    assert.equal(await User.countDocuments({ role: "client", isActive: true, _id: stuck._id }), 0, "dry run changes nothing");

    const applied = await activateStuckPassengers({ dryRun: false });
    assert.deepEqual(applied, { matched: 1, activated: 1 });
    assert.equal((await User.findById(stuck._id).lean()).isActive, true);
    assert.equal((await User.findById(stuck._id).lean()).isVerified, false);
    assert.equal((await User.findById(disabled._id).lean()).isActive, false);
});

// ─── Task 4: withdraw to a typed number with the account password ────────────

const bcrypt = require("bcrypt");
const { fund } = require("./fixtures");
let paidOut;
const stubPayouts = () => {
    paidOut = [];
    load("services/paymentService.js").requestCashOut = async (phone) => { paidOut.push(phone); return { success: true, data: { ref: `po-${++refSeq}-${Date.now()}` } }; };
};
const PASSWORD = "Driver!pass1";
const fundedDriver = async ({ password = PASSWORD } = {}) => {
    const { user } = await makeDriver({ online: false });
    await User.updateOne({ _id: user._id }, password ? { password: await bcrypt.hash(password, 4) } : { $unset: { password: 1 } });
    await fund(user._id, 20000);
    return user;
};
const withdraw = (user, body, idem = key()) => request(app).post("/api/wallet/cash-out").set(bearer(user)).set("Idempotency-Key", idem).send({ amount: 1000, ...body });
const WithdrawalRequest = () => load("models/WithdrawalRequest.js");
const Notification = () => load("models/Notification.js");
const ALERT = (amount, phone) => `Withdrawal of ${amount} RWF to ${phone} requested.`;

test("withdrawal with wrong password is 403 (not 401: the app signs out on 401) and creates nothing", async () => {
    stubPayouts();
    const driver = await fundedDriver();
    const res = await withdraw(driver, { phone: driver.phone, password: "wrong-one" });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "Incorrect password.");
    assert.equal(await WithdrawalRequest().countDocuments({ driverId: driver._id }), 0);
    assert.equal(paidOut.length, 0);
});

test("withdrawal to a typed number pays that number", async () => {
    stubPayouts();
    const driver = await fundedDriver();
    const res = await withdraw(driver, { phone: "0788999444", password: PASSWORD });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const saved = await WithdrawalRequest().findOne({ driverId: driver._id }).lean();
    assert.equal(load("services/smsService.js").normalizeRwPhone(saved.phone), "+250788999444");
    assert.equal(load("services/smsService.js").normalizeRwPhone(paidOut[0]), "+250788999444");
});

test("withdrawal to another number alerts the owner", async () => {
    stubPayouts();
    const driver = await fundedDriver();
    await withdraw(driver, { phone: "0788999555", password: PASSWORD });
    assert.ok(await Notification().findOne({ userId: driver._id, message: ALERT(1000, "+250788999555") }), "owner alerted");
});

test("withdrawal to own number sends no alert", async () => {
    stubPayouts();
    const driver = await fundedDriver();
    const res = await withdraw(driver, { phone: localForm(driver.phone), password: PASSWORD });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(await Notification().countDocuments({ userId: driver._id, message: /^Withdrawal of .* requested\.$/ }), 0);
});

test("withdrawal to an invalid number is refused", async () => {
    stubPayouts();
    const driver = await fundedDriver();
    const res = await withdraw(driver, { phone: "12345", password: PASSWORD });
    assert.equal(res.status, 400);
    assert.equal(paidOut.length, 0);
});

test("passwordless account gets 409", async () => {
    stubPayouts();
    const driver = await fundedDriver({ password: null });
    const res = await withdraw(driver, { phone: driver.phone, password: "anything" });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Set a password in your account first.");
});

test("sixth wrong password within 15 min is 429", async () => {
    stubPayouts();
    const driver = await fundedDriver();
    for (let i = 0; i < 5; i++) assert.equal((await withdraw(driver, { phone: driver.phone, password: "nope" })).status, 403);
    assert.equal((await withdraw(driver, { phone: driver.phone, password: "nope" })).status, 429);
});

test("same idempotency key: wrong password then correct creates exactly one withdrawal", async () => {
    stubPayouts();
    const driver = await fundedDriver();
    const idem = key();
    assert.equal((await withdraw(driver, { phone: driver.phone, password: "nope" }, idem)).status, 403);
    assert.equal((await withdraw(driver, { phone: driver.phone, password: PASSWORD }, idem)).status, 202);
    assert.equal((await withdraw(driver, { phone: driver.phone, password: PASSWORD }, idem)).status, 202);
    assert.equal(await WithdrawalRequest().countDocuments({ driverId: driver._id }), 1);
    assert.equal(paidOut.length, 1);
});

// ─── Final review fixes ──────────────────────────────────────────────────────

test("registration-status settling the fee also proves the phone", async () => {
    stubCollections();
    const driver = await driverAwaitingFee();
    const pay = await request(app).post("/api/auth/pay-registration").send({ phone: driver.phone });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    load("services/paymentService.js").getTransactionStatus = async () => ({ success: true, data: { status: "successful" } });
    const status = await request(app).post("/api/auth/registration-status").set("Authorization", `Bearer ${driver.sessionToken}`).send({ userId: String(driver._id) });
    assert.equal(status.body.paid, true, JSON.stringify(status.body));
    assert.equal((await User.findById(driver._id).lean()).isVerified, true);
});

test("pay-registration to another number needs the driver's own session", async () => {
    stubCollections();
    const driver = await driverAwaitingFee();
    const anonymous = await request(app).post("/api/auth/pay-registration").send({ phone: driver.phone, payerPhone: "0788999666" });
    assert.equal(anonymous.status, 401);
    assert.equal(charged.length, 0, "no MoMo prompt sent");
    const someoneElse = await driverAwaitingFee();
    const wrongSession = await request(app).post("/api/auth/pay-registration").set("Authorization", `Bearer ${someoneElse.sessionToken}`).send({ phone: driver.phone, payerPhone: "0788999666" });
    assert.equal(wrongSession.status, 403);
    assert.equal(charged.length, 0, "no MoMo prompt sent");
});

test("register refuses staff roles", async () => {
    for (const role of ["admin", "superadmin", "financial", "manager"]) {
        const res = await register({ role });
        assert.equal(res.status, 400, `${role}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.token, undefined);
    }
});

test("an admin-blocked passenger can't switch themselves on with verify-otp", async () => {
    const { generateOTPToken } = load("utils/jwt.js");
    const res = await register();
    const id = res.body.userId;
    await User.updateOne({ _id: id }, { isActive: false, activationBlocked: true, otpToken: generateOTPToken(id, "123456") });
    await request(app).post("/api/auth/verify-otp").send({ userId: id, otp: "123456" });
    assert.equal((await User.findById(id).lean()).isActive, false);
});

test("login tells an admin-blocked passenger the account is disabled", async () => {
    const phone = nextPhone();
    const res = await register({ phone });
    await User.updateOne({ _id: res.body.userId }, { isActive: false, activationBlocked: true });
    const login = await request(app).post("/api/auth/login").send({ identifier: res.body.user.phone, password: "Passw0rd!x" });
    assert.equal(login.status, 403);
    assert.equal(login.body.message, "Account disabled");
});
