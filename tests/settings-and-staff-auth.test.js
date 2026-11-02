// Settings reach the apps (pricing, maintenance, tiers, rewards) and staff sign-in is safe (2FA, reset link).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcrypt");
const speakeasy = require("speakeasy");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makeDriver, makePassenger } = require("./fixtures");

let app, User, Role, settings, SystemConfig, Session;
before(async () => {
    app = await startStack();
    User = load("models/User.js"); Role = load("models/Role.js"); SystemConfig = load("models/SystemConfig.js"); Session = load("models/Session.js");
    settings = load("services/systemSettingService.js");
});
after(stopStack);
beforeEach(async () => { await clearDb(); await settings.seedDefaults(); await settings.refreshCache(); });

async function superadmin() {
    const { STAFF_ROLE_TEMPLATES } = load("constants/staffRoles.js");
    const role = await Role.create({ name: "superadmin", description: "Owner", permissions: STAFF_ROLE_TEMPLATES.superadmin });
    const user = await User.create({ firstName: "Grace", lastName: "M", phone: "+250788000001", email: "grace@mota.test", password: await bcrypt.hash("Correct-horse-1", 12), role: "superadmin", roleId: role._id, isActive: true, isVerified: true, registrationStatus: "approved" });
    const login = await request(app).post("/api/auth/login").send({ identifier: "grace@mota.test", password: "Correct-horse-1" });
    return { user, auth: { Authorization: `Bearer ${login.body.token}` } };
}
const setSetting = (admin, key, value) => request(app).post("/api/admin/configs").set(admin.auth).send({ key, value });

test("public pricing reflects admin settings immediately", async () => {
    const admin = await superadmin();
    assert.equal((await setSetting(admin, "registration_fee", "7000")).status, 200);
    assert.equal((await setSetting(admin, "cash_out_fee_percentage", 3)).status, 200);
    const res = await request(app).get("/api/platform/pricing");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.registrationFee.driver, 7000, "stored as a number and served to the app");
    assert.equal(res.body.data.fees.cashOutPercent, 3);
    assert.equal((await SystemConfig.findOne({ key: "registration_fee" })).value, 7000);
});

test("settings are validated by type", async () => {
    const admin = await superadmin();
    assert.equal((await setSetting(admin, "ride_commission_percentage", 150)).status, 400, "percent above 100");
    assert.equal((await setSetting(admin, "registration_fee", -1)).status, 400, "negative money");
    assert.equal((await setSetting(admin, "registration_fee", "abc")).status, 400);
    assert.equal((await setSetting(admin, "maintenance_mode", "maybe")).status, 400);
    assert.equal((await setSetting(admin, "fuel_reward_tier", "diamond")).status, 400);
    assert.equal((await setSetting(admin, "support_email", "not-an-email")).status, 400);
});

test("maintenance mode pauses driver and passenger apps but not staff, sign-in or pricing", async () => {
    const admin = await superadmin();
    const driver = await makeDriver();
    assert.equal((await setSetting(admin, "maintenance_mode", true)).status, 200);
    assert.equal((await setSetting(admin, "maintenance_message", "Back at 10:00")).status, 200);
    const blocked = await request(app).get("/api/driver-finance/summary").set(driver.auth);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, "MAINTENANCE");
    assert.equal(blocked.body.message, "Back at 10:00");
    assert.equal((await request(app).get("/api/admin/configs").set(admin.auth)).status, 200, "staff keep access");
    assert.equal((await request(app).get("/api/platform/pricing")).body.data.maintenance.on, true);
    assert.notEqual((await request(app).post("/api/auth/login").send({ identifier: "x@y.z", password: "nope" })).status, 503);
    await setSetting(admin, "maintenance_mode", false);
    assert.equal((await request(app).get("/api/driver-finance/summary").set(driver.auth)).status, 200);
});

test("performance tier thresholds come from settings", async () => {
    const admin = await superadmin();
    await setSetting(admin, "perf_tier_silver_monthly_rides", 2);
    const algorithm = load("services/algorithmService.js");
    const driver = await makeDriver();
    const RiderAlgorithm = load("models/RiderAlgorithm.js");
    await RiderAlgorithm.create({ riderId: driver.user._id, monthly_rides: 1 });
    const rider = await algorithm.processRide(String(driver.user._id));
    assert.equal(rider.monthly_rides, 2);
    assert.equal(rider.current_tier, "Silver", "2 rides reaches Silver once the admin sets the threshold to 2");
});

test("2FA sign-in needs the password step's challenge; a bare user id is refused", async () => {
    const admin = await superadmin();
    const setup = await request(app).post("/api/auth/2fa/setup").set(admin.auth);
    assert.equal(setup.status, 200);
    const secret = setup.body.data.secret;
    const code = () => speakeasy.totp({ secret, encoding: "base32" });
    assert.equal((await request(app).post("/api/auth/2fa/verify").set(admin.auth).send({ token: code() })).status, 200, "turned on while signed in");
    assert.equal((await request(app).post("/api/auth/2fa/setup").set(admin.auth)).status, 409, "can't silently replace an active secret");

    const step1 = await request(app).post("/api/auth/login").send({ identifier: "grace@mota.test", password: "Correct-horse-1" });
    assert.equal(step1.body.require2FA, true);
    assert.equal(step1.body.userId, undefined, "no user id handed out");
    assert.ok(step1.body.challenge);

    const bypass = await request(app).post("/api/auth/2fa/verify").send({ userId: admin.user._id, token: code() });
    assert.equal(bypass.status, 401, "password step can't be skipped");
    assert.equal((await request(app).post("/api/auth/2fa/verify").send({ challenge: step1.body.challenge, token: "000000" })).status, 401);

    const ok = await request(app).post("/api/auth/2fa/verify").send({ challenge: step1.body.challenge, token: code() });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.user.permissions.length > 0);
    const me = await request(app).get("/api/users/me").set({ Authorization: `Bearer ${ok.body.token}` });
    assert.equal(me.status, 200);
    assert.equal(await Session.countDocuments({ userId: admin.user._id, revokedAt: null }), 2, "2FA sign-in creates a revocable session");

    const detail = await request(app).get(`/api/admin/users/${admin.user._id}`).set({ Authorization: `Bearer ${ok.body.token}` });
    assert.doesNotMatch(JSON.stringify(detail.body), new RegExp(secret), "secret never returned");

    const off = await request(app).post("/api/auth/2fa/disable").set({ Authorization: `Bearer ${ok.body.token}` }).send({ password: "Correct-horse-1", code: code() });
    assert.equal(off.status, 200);
    assert.equal((await request(app).post("/api/auth/login").send({ identifier: "grace@mota.test", password: "Correct-horse-1" })).body.require2FA, undefined);
});

test("staff password reset links open the admin website; drivers get the app link", () => {
    const { passwordResetUrl } = load("services/authService.js");
    assert.equal(passwordResetUrl({ role: "superadmin" }, "abc"), "https://mota-admin-web-app.vercel.app/reset-password?token=abc");
    assert.equal(passwordResetUrl({ role: "financial" }, "abc"), "https://mota-admin-web-app.vercel.app/reset-password?token=abc");
    assert.equal(passwordResetUrl({ role: "driver" }, "abc"), "mota://reset-password?token=abc");
    assert.equal(passwordResetUrl({ role: "client" }, "abc"), "mota://reset-password?token=abc");
});

test("admin ledger lists MOTA transactions with people and totals", async () => {
    const admin = await superadmin();
    const passenger = await makePassenger();
    const Transaction = load("models/Transaction.js");
    await Transaction.create([
        { driverId: passenger.user._id, amount: 2000, type: "cash_in", status: "successful" },
        { driverId: passenger.user._id, amount: -1500, type: "ride_payment", status: "successful" },
        { driverId: passenger.user._id, amount: 500, type: "cash_in", status: "failed" },
    ]);
    const res = await request(app).get("/api/admin/ledger").set(admin.auth).query({ q: passenger.user.phone });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 3);
    assert.equal(res.body.data[0].driverId.firstName, "Aline");
    const cashIn = res.body.totals.find((t) => t._id === "cash_in");
    assert.equal(cashIn.amount, 2000, "totals count successful entries only");
    const driver = await makeDriver();
    assert.equal((await request(app).get("/api/admin/ledger").set(driver.auth)).status, 403);
});
