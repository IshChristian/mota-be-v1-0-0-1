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

// ── Single-use access requests ───────────────────────────────────────────
const Notification = () => load("models/Notification.js");
const AccessRequest = () => load("models/AccessRequest.js");
const ask = (who, body) => request(app).post("/api/access-requests").set(who.auth).send(body);
const decide = (who, id, decision, note = "ok") => request(app).post(`/api/access-requests/${id}/${decision}`).set(who.auth).send({ note });
const removeUser = (who, id) => request(app).delete(`/api/admin/users/${id}`).set(who.auth);

test("an approved request allows that one action on that one user, once", async () => {
    const owner = await makePassenger({ role: "superadmin" });
    const hr = await makePassenger({ role: "admin" });
    const target = await makePassenger();
    const other = await makePassenger();
    assert.equal((await removeUser(hr, target.user._id)).status, 403, "admins can't delete users");

    const asked = await ask(hr, { permission: "user:delete", targetType: "User", targetId: String(target.user._id), reason: "Duplicate account, customer asked" });
    assert.equal(asked.status, 201, asked.body.message);
    assert.ok(await Notification().findOne({ userId: owner.user._id, title: "Access request" }), "superadmin is told");
    assert.equal((await removeUser(hr, target.user._id)).status, 403, "not before approval");

    const approved = await decide(owner, asked.body.data._id, "approve");
    assert.equal(approved.status, 200, approved.body.message);
    assert.ok(await Notification().findOne({ userId: hr.user._id, title: "Access request approved" }));
    assert.equal((await removeUser(hr, other.user._id)).status, 403, "only the approved user");
    assert.equal((await removeUser(hr, target.user._id)).status, 200, "the approved action works");
    const used = await AccessRequest().findById(asked.body.data._id).lean();
    assert.equal(used.status, "used");
    assert.equal((await removeUser(hr, other.user._id)).status, 403, "and it can't be reused");
});

test("one approval used twice at the same moment works once", async () => {
    const owner = await makePassenger({ role: "superadmin" });
    const hr = await makePassenger({ role: "admin" });
    const target = await makePassenger();
    const asked = await ask(hr, { permission: "user:delete", targetType: "User", targetId: String(target.user._id), reason: "Duplicate account" });
    await decide(owner, asked.body.data._id, "approve");
    const results = await Promise.all([removeUser(hr, target.user._id), removeUser(hr, target.user._id)]);
    assert.equal(results.filter((r) => r.status === 403).length, 1, "one of them is refused");
});

test("only a superadmin approves; expired or declined approvals don't work", async () => {
    const owner = await makePassenger({ role: "superadmin" });
    const hr = await makePassenger({ role: "admin" });
    const target = await makePassenger();
    const asked = await ask(hr, { permission: "user:delete", targetType: "User", targetId: String(target.user._id), reason: "Duplicate account" });
    assert.equal((await decide(hr, asked.body.data._id, "approve")).status, 403, "can't approve your own or anyone's");
    await decide(owner, asked.body.data._id, "approve");
    await AccessRequest().updateOne({ _id: asked.body.data._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await removeUser(hr, target.user._id)).status, 403, "expired");

    const again = await ask(hr, { permission: "user:delete", targetType: "User", targetId: String(target.user._id), reason: "Still a duplicate" });
    assert.equal((await decide(owner, again.body.data._id, "decline", "Merge instead")).status, 200);
    assert.equal((await removeUser(hr, target.user._id)).status, 403, "declined");
});

test("requests are refused for permissions you have or that only the superadmin holds", async () => {
    const hr = await makePassenger({ role: "admin" });
    assert.equal((await ask(hr, { permission: "user:view", reason: "Need to look users up" })).status, 400);
    assert.equal((await ask(hr, { permission: "access_request:approve", reason: "Approve for others" })).status, 400);
    assert.equal((await ask(hr, { permission: "made:up", reason: "Something else" })).status, 400);
    const mine = await request(app).get("/api/access-requests?mine=1").set(hr.auth);
    assert.equal(mine.status, 200);
});
