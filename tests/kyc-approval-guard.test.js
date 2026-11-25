// A driver is approved only when staff approve their submitted KYC.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makePassenger, makeDriver } = require("./fixtures");
let app, User, DriverKyc, AuditLog;
before(async () => { app = await startStack(); User = load("models/User.js"); DriverKyc = load("models/DriverKyc.js"); AuditLog = load("models/AuditLog.js"); });
after(stopStack);
beforeEach(clearDb);

const pendingDriver = async (kycLevel) => {
    const d = await makeDriver({ online: false });
    await User.updateOne({ _id: d.user._id }, { kycLevel, registrationStatus: "pending", isActive: false });
    await DriverKyc.updateOne({ userId: d.user._id }, { status: "submitted" });
    return d;
};
const me = (d) => request(app).get("/api/users/me").set(d.auth);

test("a submitted KYC is never activated, even if the account level says full", async () => {
    const d = await pendingDriver("full");
    const res = await me(d);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.onboarding.kycStatus, "submitted");
    const u = await User.findById(d.user._id).lean();
    assert.equal(u.registrationStatus, "pending");
    assert.equal(u.isActive, false);
});
test("legacy full accounts with no KYC record still activate", async () => {
    const d = await pendingDriver("full");
    await DriverKyc.deleteMany({});
    await me(d);
    assert.equal((await User.findById(d.user._id).lean()).registrationStatus, "approved");
});
for (const [name, send] of [
    ["account edit", (admin, id) => request(app).patch(`/api/admin/users/${id}`).set(admin.auth).send({ kycLevel: "full" })],
    ["KYC level endpoint", (admin, id) => request(app).put(`/api/admin/users/${id}/kyc`).set(admin.auth).send({ kycLevel: "full" })],
]) test(`${name} can't set full while the KYC waits for review`, async () => {
    const admin = await makePassenger({ role: "superadmin" });
    const d = await pendingDriver("basic");
    const res = await send(admin, d.user._id);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal((await User.findById(d.user._id).lean()).kycLevel, "basic");
});
test("staff approval still activates the driver", async () => {
    const admin = await makePassenger({ role: "superadmin" });
    const d = await pendingDriver("basic");
    const kyc = await DriverKyc.findOne({ userId: d.user._id });
    const res = await request(app).patch(`/api/admin/kyc/driver/${kyc._id}/review`).set(admin.auth).send({ status: "approved" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const u = await User.findById(d.user._id).lean();
    assert.deepEqual([u.kycLevel, u.registrationStatus, u.isActive], ["full", "approved", true]);
    const detail = await request(app).get(`/api/admin/kyc/driver/${kyc._id}`).set(admin.auth);
    assert.equal(detail.body.data.reviewedBy.firstName, "Aline");
});
test("staff SMS a driver from the live map", async () => {
    const admin = await makePassenger({ role: "superadmin" });
    const d = await makeDriver();
    const url = `/api/admin/drivers/${d.user._id}/sms`;
    assert.equal((await request(app).post(url).set(admin.auth).send({ message: " " })).status, 400);
    const passenger = await makePassenger();
    assert.equal((await request(app).post(url).set(passenger.auth).send({ message: "Hello" })).status, 403);
    // No SMS API key in tests: the failure must be reported.
    assert.equal((await request(app).post(url).set(admin.auth).send({ message: "Hello" })).status, 502);
    process.env.AT_API_KEY = "t"; process.env.AT_USERNAME = "mota"; const real = global.fetch; let sent;
    global.fetch = async (_u, o) => { sent = JSON.parse(o.body); return { ok: true, status: 201, json: async () => ({ SMSMessageData: { Recipients: [{ statusCode: 101, status: "Success" }] } }) }; };
    try {
        const ok = await request(app).post(url).set(admin.auth).send({ message: "Hello" });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.deepEqual(sent.phoneNumbers, [d.user.phone]); assert.equal(sent.message, "Hello");
        assert.equal(await AuditLog.countDocuments({ action: "driver_sms_sent", targetId: d.user._id }), 2);
    } finally { global.fetch = real; process.env.AT_API_KEY = ""; process.env.AT_USERNAME = ""; }
});
