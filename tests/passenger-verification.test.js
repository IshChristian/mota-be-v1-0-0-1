// Passengers confirm their email and submit their ID (front, back, selfie) before booking a ride.
// Staff review the ID afterwards; drivers are unaffected.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack } = require("./harness");
const { load, makePassenger, requestRide } = require("./fixtures");

let app, User, PassengerKyc;
let seq = 0;
before(async () => { app = await startStack(); User = load("models/User.js"); PassengerKyc = load("models/PassengerKyc.js"); });
after(stopStack);

const MSG = "Confirm your email and submit your ID before booking a ride.";
const doc = "https://res.cloudinary.com/test/doc.jpg";
const kyc = (userId, status) => PassengerKyc.create({ userId, nationalIdNumber: `1199880${String(100000000 + ++seq)}`, nationalIdFront: doc, nationalIdBack: doc, selfie: doc, status });
const fresh = async (extra) => makePassenger({ withoutKyc: true, isEmailVerified: false, ...extra });
const register = (body) => request(app).post("/api/auth/register").send({
    firstName: "New", lastName: "User", phone: `078${String(6000000 + ++seq).slice(-7)}`, nationalId: `1199880${String(200000000 + seq)}`, password: "Passw0rd!x", ...body,
});

test("passenger sign-up needs an email", async () => {
    const res = await register({ role: "client" });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Email is required for passengers.");
    const ok = await register({ role: "client", email: `rider${seq}@mota.test` });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("driver sign-up without email still works", async () => {
    assert.equal((await register({ role: "driver" })).status, 201);
});

test("unverified passenger can't request a ride", async () => {
    const passenger = await fresh();
    const res = await requestRide(app, passenger);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, { code: "VERIFY_TO_RIDE", message: MSG, needs: { email: true, identity: true } });
});

test("email confirmed but no ID: needs identity", async () => {
    const passenger = await fresh({ isEmailVerified: true });
    const res = await requestRide(app, passenger);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body.needs, { email: false, identity: true });
});

test("ID submitted but email not confirmed: needs email", async () => {
    const passenger = await fresh();
    await kyc(passenger.user._id, "submitted");
    assert.deepEqual((await requestRide(app, passenger)).body.needs, { email: true, identity: false });
});

test("email confirmed and ID submitted can request", async () => {
    const passenger = await fresh({ isEmailVerified: true });
    await kyc(passenger.user._id, "submitted");
    const res = await requestRide(app, passenger);
    assert.notEqual(res.status, 403, JSON.stringify(res.body));
});

test("ID in correction still allowed", async () => {
    const passenger = await fresh({ isEmailVerified: true });
    await kyc(passenger.user._id, "correction");
    assert.notEqual((await requestRide(app, passenger)).status, 403);
});

test("a draft or rejected ID doesn't count", async () => {
    for (const status of ["draft", "rejected"]) {
        const passenger = await fresh({ isEmailVerified: true });
        await kyc(passenger.user._id, status);
        assert.equal((await requestRide(app, passenger)).status, 403, status);
    }
});

test("scheduled request is gated too", async () => {
    const passenger = await fresh();
    const later = new Date(Date.now() + 3 * 3600 * 1000);
    const res = await requestRide(app, passenger, { scheduledDate: later.toISOString().slice(0, 10), scheduledTime: later.toISOString().slice(11, 16) });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "VERIFY_TO_RIDE");
});
