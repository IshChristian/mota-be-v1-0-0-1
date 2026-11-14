// Phone proven by payment: sign-up needs no SMS code; a successful MoMo payment from the
// registered number sets isVerified; loans and referrals keep requiring it.
const { test, before, after } = require("node:test");
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
