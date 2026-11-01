const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startStack, stopStack, clearDb } = require("./harness");
const request = require("supertest");
const { load, makePassenger, makeDriver, requestRide } = require("./fixtures");

let app, User, Referral, Wallet, Ride;
before(async () => { app = await startStack(); User = load("models/User.js"); Referral = load("models/Referral.js"); Wallet = load("models/Wallet.js"); Ride = load("models/Ride.js"); });
after(stopStack);
beforeEach(clearDb);

const staff = (role, extra = {}) => makePassenger({ role, ...extra });
const get = (who, path) => request(app).get(path).set(who.auth);
const put = (who, path, body) => request(app).put(path).set(who.auth).send(body);
const post = (who, path, body = {}) => request(app).post(path).set(who.auth).send(body);

// Reports, access grants, support, roles, KYC review and referrals are covered by main's own tests
// (reporting/support/referral-service/role-kyc-workflows/upload-signature *.test.cjs).

test("driver performance: acceptance and cancellation rates from acknowledged offers", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const { body } = await requestRide(app, passenger);
    const id = body.data.rideId;
    assert.equal((await post(driver, `/api/driver/offers/${id}/received`)).status, 200);
    assert.equal((await post(driver, `/api/driver/offers/${id}/received`)).status, 200, "repeat is idempotent");
    await post(driver, `/api/rides/${id}/accept`);
    const perf = await get(driver, "/api/driver/performance?days=7");
    assert.equal(perf.status, 200);
    assert.equal(perf.body.data.offers, 1);
    assert.equal(perf.body.data.accepted, 1);
    assert.equal(perf.body.data.acceptanceRate, 100);
    assert.equal(perf.body.data.cancellationRate, 0);
    const other = await makeDriver();
    assert.equal((await post(other, `/api/driver/offers/${id}/received`)).status, 404, "only drivers who got the offer");
});

test("staff payment status corrections: reason required, finished rides only, audited", async () => {
    const AuditLog = load("models/AuditLog.js");
    const admin = await staff("admin");
    const support = await staff("caller_support");
    const driver = await makeDriver();
    await User.updateOne({ _id: driver.user._id }, { $set: { registrationPaid: false } });
    const patch = (who, path, body) => request(app).patch(path).set(who.auth).send(body);
    assert.equal((await patch(admin, `/api/admin/users/${driver.user._id}/registration-payment`, { paid: true, reason: "x" })).status, 400, "reason required");
    assert.equal((await patch(support, `/api/admin/users/${driver.user._id}/registration-payment`, { paid: true, reason: "Paid cash at office" })).status, 403);
    const ok = await patch(admin, `/api/admin/users/${driver.user._id}/registration-payment`, { paid: true, reason: "Paid cash at office, receipt 42" });
    assert.equal(ok.status, 200, ok.body.message);
    assert.equal((await User.findById(driver.user._id)).registrationPaid, true);
    assert.ok(await AuditLog.exists({ action: "registration_payment_updated", targetId: driver.user._id }));
    const passenger = await makePassenger();
    assert.equal((await patch(admin, `/api/admin/users/${passenger.user._id}/registration-payment`, { paid: true, reason: "Paid cash at office" })).status, 400, "passengers have no fee");

    const { body } = await requestRide(app, passenger);
    const id = body.data.rideId;
    assert.equal((await patch(admin, `/api/admin/rides/${id}/payment`, { paymentStatus: "successful", reason: "Paid outside app" })).status, 409, "trip not finished");
    await Ride.updateOne({ _id: id }, { $set: { rideStatus: "awaiting_payment", paymentStatus: "pending" } });
    const ride = await patch(admin, `/api/admin/rides/${id}/payment`, { paymentStatus: "successful", reason: "Passenger paid by bank transfer" });
    assert.equal(ride.status, 200, ride.body.message);
    assert.equal((await Ride.findById(id)).paymentStatus, "successful");
    assert.ok(ride.body.warnings.some((w) => /finish the trip/.test(w)));
    assert.equal((await patch(admin, `/api/admin/rides/${id}/payment`, { paymentStatus: "refunded", reason: "Passenger paid" })).status, 400);
});

test("driver KYC renewal: approved+valid stays locked; expired document can be renewed and goes back to review", async () => {
    const DriverKyc = load("models/DriverKyc.js");
    const driver = await makeDriver();
    const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const valid = { drivingLicenseExpiresAt: future(400), transportPermitExpiresAt: future(400), insuranceExpiresAt: future(400), vehicleRegistrationExpiresAt: future(400), technicalInspectionExpiresAt: future(400) };
    await DriverKyc.updateOne({ userId: driver.user._id }, { $set: valid });
    const doc = "https://res.cloudinary.com/test/new.jpg";
    const body = (over = {}) => ({ nationalIdNumber: "1199080012345678", nationalIdFront: doc, nationalIdBack: doc, selfie: doc, drivingLicenseNumber: "DL1", drivingLicenseDocument: doc, transportPermitNumber: "TP1", transportPermitDocument: doc, insuranceDocument: doc, vehicleRegistrationDocument: doc, technicalInspectionDocument: doc, plateNumber: "RAB999C", vehicleType: "moto", powertrain: "petrol", ...valid, ...over });

    const me = await get(driver, "/api/kyc/me");
    assert.equal(me.body.renewal.due, false);
    assert.equal((await put(driver, "/api/kyc/me", body())).status, 409, "valid approved documents stay locked");

    await DriverKyc.updateOne({ userId: driver.user._id }, { $set: { insuranceExpiresAt: new Date(Date.now() - 86400000) } });
    const due = await get(driver, "/api/kyc/me");
    assert.equal(due.body.renewal.due, true);
    assert.deepEqual(due.body.renewal.expired.map((d) => d.documentField), ["insuranceDocument"]);
    assert.equal((await put(driver, "/api/kyc/me", body({ insuranceExpiresAt: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }))).status, 400, "the new expiry must be in the future");
    const renewed = await put(driver, "/api/kyc/me", body({ insuranceExpiresAt: future(365) }));
    assert.equal(renewed.status, 200, renewed.body.message);
    assert.equal(renewed.body.renewal, true);
    assert.equal(renewed.body.data.status, "submitted");
    assert.equal((await DriverKyc.findOne({ userId: driver.user._id })).insuranceDocument, doc);

    await DriverKyc.updateOne({ userId: driver.user._id }, { $set: { status: "approved", insuranceExpiresAt: new Date(Date.now() + 10 * 86400000) } });
    assert.equal((await get(driver, "/api/kyc/me")).body.renewal.expiringSoon.length, 1, "renewal opens 30 days before expiry");
});

test("staff edit KYC fields: validated, audited, clears that field's review, rejects stale copies", async () => {
    const DriverKyc = load("models/DriverKyc.js");
    const AuditLog = load("models/AuditLog.js");
    const admin = await staff("admin");
    const support = await staff("caller_support");
    const driver = await makeDriver();
    const kyc = await DriverKyc.findOne({ userId: driver.user._id });
    await DriverKyc.updateOne({ _id: kyc._id }, { $set: { fieldReviews: [{ key: "insuranceDocument", status: "correction", reason: "Blurry" }, { key: "selfie", status: "approved", reason: "" }] } });
    const fresh = await get(admin, `/api/admin/kyc/driver/${kyc._id}`);
    const patch = (who, body) => request(app).patch(`/api/admin/kyc/driver/${kyc._id}/fields`).set(who.auth).send(body);

    assert.equal((await patch(support, { updates: { plateNumber: "RAC111D" }, reason: "Typo in plate" })).status, 403);
    assert.equal((await patch(admin, { updates: { plateNumber: "RAC111D" }, reason: "x" })).status, 400, "reason required");
    assert.equal((await patch(admin, { updates: { userId: "x" }, reason: "Fix owner" })).status, 400, "only KYC fields");
    assert.equal((await patch(admin, { updates: { insuranceDocument: "http://insecure" }, reason: "New file" })).status, 400);
    assert.equal((await patch(admin, { updates: { vehicleType: "bus" }, reason: "Fix type" })).status, 400);
    assert.equal((await patch(admin, { updates: { drivingLicenseNumber: "" }, reason: "Clear it" })).status, 400, "required field can't be emptied");

    const ok = await patch(admin, { updates: { plateNumber: "rac 111d", insuranceDocument: "https://res.cloudinary.com/x/new.pdf", insuranceExpiresAt: "2030-05-01", vehicleType: "car", cooperativeName: "" }, reason: "Driver sent corrected insurance in person", expectedUpdatedAt: fresh.body.data.updatedAt });
    assert.equal(ok.status, 200, ok.body.message);
    const after = await DriverKyc.findById(kyc._id);
    assert.equal(after.plateNumber, "RAC 111D");
    assert.equal(after.vehicleType, "car");
    assert.equal(after.insuranceExpiresAt.toISOString().slice(0, 10), "2030-05-01");
    assert.deepEqual(after.fieldReviews.map((r) => r.key), ["selfie"], "edited field's review cleared; others kept");
    const audit = await AuditLog.findOne({ action: "kyc_fields_updated", targetId: kyc._id });
    assert.equal(audit.metadata.reason, "Driver sent corrected insurance in person");
    assert.equal(audit.metadata.after.vehicleType, "car");

    assert.equal((await patch(admin, { updates: { plateNumber: "RAD222E" }, reason: "Another fix", expectedUpdatedAt: fresh.body.data.updatedAt })).status, 409, "stale copy");
    const warn = await patch(admin, { updates: { insuranceExpiresAt: "2020-01-01" }, reason: "Real expiry date" });
    assert.ok(warn.body.warnings.some((w) => /past/.test(w)));
});
