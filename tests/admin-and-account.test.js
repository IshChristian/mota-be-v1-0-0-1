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

test("admin login permissions: /reports/access/me works for every staff role", async () => {
    const sa = await staff("superadmin");
    const admin = await staff("admin");
    const fin = await staff("financial");
    const me = await get(sa, "/api/reports/access/me");
    assert.equal(me.status, 200);
    assert.ok(me.body.data.permissions.includes("admin:access"));
    assert.ok(me.body.data.permissions.includes("data:access_manage"));
    const a = (await get(admin, "/api/reports/access/me")).body.data.permissions;
    assert.ok(a.includes("admin:access") && a.includes("analytics:users") && a.includes("audit:view"));
    assert.ok(!a.includes("audit:sensitive"), "sensitive audit view is never inherited");
    const f = (await get(fin, "/api/reports/access/me")).body.data.permissions;
    assert.ok(f.includes("analytics:finance"));
    const passenger = await makePassenger();
    assert.ok(!(await get(passenger, "/api/reports/access/me")).body.data.permissions.includes("admin:access"));
});

test("report access grants: replace inherited scopes; managers can't grant beyond their own", async () => {
    const sa = await staff("superadmin");
    const admin = await staff("admin");
    const fin = await staff("financial");
    assert.equal((await put(admin, `/api/reports/access/users/${fin.user._id}`, { permissions: ["analytics:view"] })).status, 403, "admin lacks data:access_manage by default");
    const grant = await put(sa, `/api/reports/access/users/${admin.user._id}`, { permissions: ["analytics:view", "analytics:users", "data:access_manage"] });
    assert.equal(grant.status, 200, grant.body.message);
    const now = (await get(admin, "/api/reports/access/me")).body.data.permissions;
    assert.ok(now.includes("data:access_manage") && !now.includes("audit:view"), "explicit grant replaced inherited report scopes");
    assert.equal((await put(admin, `/api/reports/access/users/${fin.user._id}`, { permissions: ["audit:sensitive"] })).status, 403);
    assert.equal((await put(admin, `/api/reports/access/users/${fin.user._id}`, { permissions: ["analytics:users"] })).status, 200);
    const list = await get(sa, "/api/reports/access/users?q=");
    assert.ok(list.body.data.every((u) => !["client", "driver"].includes(u.role)));
});

test("reports: summary, records, investigation and both export formats", async () => {
    const sa = await staff("superadmin");
    const passenger = await makePassenger();
    await makeDriver();
    await requestRide(app, passenger);
    const summary = await get(sa, "/api/reports/summary?section=rides");
    assert.equal(summary.status, 200, summary.body.message);
    assert.equal(summary.body.data.sections.rides.cards.Requests, 1);
    assert.equal(summary.body.data.period.timezone, "Africa/Kigali");
    const all = await get(sa, "/api/reports/summary");
    assert.equal(Object.keys(all.body.data.sections).length, 11);
    const users = await get(sa, "/api/reports/records/users");
    assert.ok(users.body.data.rows.length >= 2);
    const admin = await staff("admin");
    const masked = await get(admin, "/api/reports/records/users");
    assert.ok(masked.body.data.rows.every((r) => !r.phone || r.phone.includes("•")), "phones masked without audit:sensitive");
    assert.equal((await get(sa, "/api/reports/summary?from=2020-01-01&to=2026-12-31")).status, 400, "max 366 days");
    const inv = await get(sa, `/api/reports/investigate/User/${passenger.user._id}`);
    assert.equal(inv.status, 200);
    assert.equal(inv.body.data.rides.length, 1);
    const xlsx = await request(app).get("/api/reports/export/rides/xlsx").set(sa.auth).buffer(true).parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.body.slice(0, 2).toString(), "PK", "xlsx is a zip container");
    const pdf = await request(app).get("/api/reports/export/rides/pdf").set(sa.auth).buffer(true).parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(pdf.body.slice(0, 4).toString(), "%PDF");
    assert.equal((await get(admin, "/api/reports/export/rides/pdf")).status, 403, "export needs analytics:export");
});

test("support: customer ticket ↔ staff reply; internal notes stay hidden; summary counts", async () => {
    const passenger = await makePassenger();
    const agent = await staff("admin");
    const created = await post(passenger, "/api/support", { subject: "Charged twice", description: "My MoMo was charged twice for one ride", category: "payment" });
    assert.equal(created.status, 201, created.body.message);
    const id = created.body.data._id;
    assert.equal((await post(passenger, "/api/support", { subject: "x", description: "y", category: "fuel" })).status, 400);
    assert.equal((await get(agent, "/api/admin/support-summary")).body.data.waiting, 1);
    assert.equal((await post(agent, `/api/admin/support-cases/${id}/messages`, { text: "Check Paypack ref first", internal: true })).status, 200);
    const reply = await post(agent, `/api/admin/support-cases/${id}/messages`, { text: "We're refunding the duplicate.", internal: false });
    assert.equal(reply.body.data.status, "in_progress");
    const mine = await get(passenger, `/api/support/${id}`);
    assert.deepEqual(mine.body.data.messages.map((m) => m.authorType), ["customer", "staff"], "internal note hidden");
    assert.equal((await get(agent, "/api/admin/support-summary")).body.data.waiting, 0);
    const list = await get(passenger, "/api/support");
    assert.equal(list.body.totalItems, 1);
    assert.equal((await get(await makePassenger(), `/api/support/${id}`)).status, 404);
});

test("roles: permission catalog and assignable roles respect the requester's own permissions", async () => {
    const sa = await staff("superadmin");
    const fin = await staff("financial");
    const cat = await get(sa, "/api/roles/permissions");
    assert.equal(cat.status, 200);
    assert.ok(cat.body.data.groups.fuel_voucher.includes("fuel_voucher:manage"));
    assert.deepEqual(cat.body.data.grantable.length, cat.body.data.permissions.length);
    const assignable = await get(sa, "/api/roles/assignable");
    assert.ok(assignable.body.data.some((r) => r.name === "admin") && !assignable.body.data.some((r) => r.name === "superadmin"));
    assert.equal((await get(fin, "/api/roles/assignable")).status, 403);
});

test("KYC detail and review: second reviewer with a stale copy gets 409", async () => {
    const DriverKyc = load("models/DriverKyc.js");
    const admin = await staff("admin");
    const driver = await makeDriver();
    const kyc = await DriverKyc.findOne({ userId: driver.user._id });
    const detail = await get(admin, `/api/admin/kyc/driver/${kyc._id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.requirements.includes("drivingLicenseNumber"));
    const stamp = detail.body.data.updatedAt;
    const first = await request(app).patch(`/api/admin/kyc/driver/${kyc._id}/review`).set(admin.auth).send({ status: "correction", remarks: "Licence photo blurry", expectedUpdatedAt: stamp, fieldReviews: [{ key: "drivingLicenseDocument", status: "correction", reason: "Blurry" }] });
    assert.equal(first.status, 200, first.body.message);
    assert.equal(first.body.data.fieldReviews[0].key, "drivingLicenseDocument");
    const stale = await request(app).patch(`/api/admin/kyc/driver/${kyc._id}/review`).set(admin.auth).send({ status: "approved", expectedUpdatedAt: stamp });
    assert.equal(stale.status, 409);
});

test("referrals: reward fixed at signup, paid once after approval, never for passengers", async () => {
    process.env.FINANCIAL_WRITES_ENABLED = "true";
    try {
        const referrer = await makeDriver();
        await User.updateOne({ _id: referrer.user._id }, { $set: { referralCode: "MOTA-ABC123" } });
        const invitee = await makeDriver();
        const svc = load("services/referralService.js");
        const ref = await svc.recordSignup("mota-abc123", await User.findById(invitee.user._id));
        assert.equal(ref.reward, 5000);
        await User.updateOne({ _id: invitee.user._id }, { $set: { kycLevel: "full", registrationPaid: true, registrationStatus: "approved", isVerified: true } });
        const results = await Promise.all([svc.settle(ref._id), svc.settle(ref._id)]);
        assert.deepEqual(results.sort(), ["already", "paid"]);
        assert.equal((await Wallet.findOne({ driverId: referrer.user._id })).balance, 5000);
        const me = await get(referrer, "/api/referrals/me");
        assert.equal(me.body.data.totalEarned, 5000);
        assert.equal(me.body.data.records[0].referredUserId, undefined, "invitee identity not exposed");
        const passengerInvite = await svc.recordSignup("MOTA-ABC123", await User.findById((await makePassenger()).user._id));
        assert.equal(passengerInvite.reward, 0);
    } finally { delete process.env.FINANCIAL_WRITES_ENABLED; }
});

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
