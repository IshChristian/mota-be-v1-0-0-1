// Staff see only what their permissions allow: view-only roles get basic
// details, never money, identity documents or account secrets.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makePassenger, makeDriver, fund } = require("./fixtures");

let app, User;
before(async () => { app = await startStack(); User = load("models/User.js"); });
after(stopStack);
beforeEach(clearDb);

const get = (who, path) => request(app).get(path).set(who.auth);
const SECRETS = ["password", "otpToken", "emailOtpToken", "twoFactorSecret", "pushTokens"];

async function customerWithSecrets() {
    const driver = await makeDriver();
    await User.updateOne({ _id: driver.user._id }, { $set: { password: "$2a$10$hash", otpToken: "123456", nationalId: "1199080012345678", fuelVouchers: [{ code: "FV-1", amount: 1000, type: "qr" }] } });
    await fund(driver.user._id, 7000);
    return driver;
}

test("caller support's user list has no secrets, ID numbers or money", async () => {
    const customer = await customerWithSecrets();
    const support = await makePassenger({ role: "caller_support" });
    const res = await get(support, "/api/admin/users");
    assert.equal(res.status, 200, res.body.message);
    const row = res.body.data.find((u) => u._id === String(customer.user._id));
    assert.ok(row, "basic details are listed");
    assert.equal(row.phone, customer.user.phone);
    for (const key of [...SECRETS, "nationalId", "fuelVouchers"]) assert.equal(row[key], undefined, `${key} hidden`);
});

test("caller support's user detail and overview hide money and identity", async () => {
    const customer = await customerWithSecrets();
    const support = await makePassenger({ role: "caller_support" });
    const detail = await get(support, `/api/admin/users/${customer.user._id}`);
    assert.equal(detail.status, 200, detail.body.message);
    for (const key of [...SECRETS, "nationalId", "fuelVouchers"]) assert.equal(detail.body.data[key], undefined, `${key} hidden`);
    const overview = await get(support, `/api/admin/users/${customer.user._id}/overview`);
    assert.equal(overview.status, 200, overview.body.message);
    assert.equal(overview.body.data.wallet, null);
    assert.deepEqual(overview.body.data.transactions, []);
    assert.equal(overview.body.data.user.nationalId, undefined);
    assert.equal(overview.body.data.user.fuelVouchers, undefined);
});

test("staff with money and KYC access still see those fields, never secrets", async () => {
    const customer = await customerWithSecrets();
    const admin = await makePassenger({ role: "admin" });
    const detail = await get(admin, `/api/admin/users/${customer.user._id}`);
    assert.equal(detail.body.data.nationalId, "1199080012345678");
    assert.equal(detail.body.data.fuelVouchers.length, 1);
    for (const key of SECRETS) assert.equal(detail.body.data[key], undefined, `${key} hidden`);
});

test("Paypack transaction lists and sync need money permissions", async () => {
    const support = await makePassenger({ role: "caller_support" });
    assert.equal((await get(support, "/api/admin/paypack/transactions")).status, 403);
    assert.equal((await get(support, "/api/admin/paypack/events")).status, 403);
    assert.equal((await request(app).post("/api/admin/paypack/sync").set(support.auth).send({})).status, 403);
});

test("no admin list sends account secrets (drivers list)", async () => {
    await customerWithSecrets();
    const admin = await makePassenger({ role: "admin" });
    const res = await get(admin, "/api/admin/drivers");
    assert.equal(res.status, 200, res.body.message);
    const rows = res.body.data || res.body.drivers || [];
    assert.ok(rows.length >= 1);
    for (const row of rows) for (const key of SECRETS) assert.equal(row[key], undefined, `${key} hidden`);
});
