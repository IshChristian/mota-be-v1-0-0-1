const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startStack, stopStack, clearDb } = require("./harness");
const request = require("supertest");
const { load, makeDriver, makePassenger } = require("./fixtures");

let app, User, RiderAlgorithm, Wallet, WithdrawalRequest, Transaction;
before(async () => {
    app = await startStack();
    User = load("models/User.js"); RiderAlgorithm = load("models/RiderAlgorithm.js"); Wallet = load("models/Wallet.js");
    WithdrawalRequest = load("models/WithdrawalRequest.js"); Transaction = load("models/Transaction.js");
});
after(stopStack);
beforeEach(clearDb);

let n = 0;
const key = () => `fuel-test-key-${++n}-${Date.now()}`;
const claim = (who, type, k = key()) => request(app).post(`/api/fuel-vouchers/claim-${type}`).set(who.auth).set("Idempotency-Key", k).send({});
const gold = async (driver) => RiderAlgorithm.create({ riderId: driver.user._id, current_tier: "Gold", features_unlocked: ["fuel_voucher"] });

test("Bronze drivers are told why they can't request; passengers are refused", async () => {
    const driver = await makeDriver();
    const status = await request(app).get("/api/fuel-vouchers/daily-status").set(driver.auth);
    assert.equal(status.body.data.eligible, false);
    assert.match(status.body.data.reason, /Gold/);
    assert.equal(status.body.data.amount, 1000);
    assert.equal((await claim(driver, "qr")).status, 403);
    assert.equal((await claim(await makePassenger(), "qr")).status, 403);
});

test("QR voucher: daily limit holds under simultaneous taps; replays return the same voucher", async () => {
    const driver = await makeDriver();
    await gold(driver);
    const k = key();
    const first = await claim(driver, "qr", k);
    assert.equal(first.status, 200, first.body.message);
    assert.match(first.body.data.qrCode, /^MOTA-QR-/);
    const replay = await claim(driver, "qr", k);
    assert.equal(replay.body.data.id, first.body.data.id, "same key → same voucher");
    const results = await Promise.all([claim(driver, "qr"), claim(driver, "qr"), claim(driver, "qr")]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, "only one more fits under the limit of 2");
    assert.ok(results.some((r) => r.status === 409));
    const status = await request(app).get("/api/fuel-vouchers/daily-status").set(driver.auth);
    assert.equal(status.body.data.qrUsed, 2);
    const one = await request(app).get(`/api/fuel-vouchers/${first.body.data.id}`).set(driver.auth);
    assert.equal(one.status, 200, "GET /fuel-vouchers/:id exists now");
    assert.equal(one.body.data.status, "active");
});

test("MoMo voucher is MOTA-funded and queued through the withdrawal pipeline", async () => {
    const driver = await makeDriver();
    await gold(driver);
    const res = await claim(driver, "momo");
    assert.equal(res.status, 200, res.body.message);
    assert.equal(res.body.data.status, "queued", "below the provider minimum it waits in the queue");
    const request_ = await WithdrawalRequest.findOne({ driverId: driver.user._id });
    assert.equal(request_.amount, 1000);
    assert.equal(request_.fee, 0);
    const wallet = await Wallet.findOne({ driverId: driver.user._id });
    assert.equal(wallet.balance, 0, "the driver's own balance is not touched");
    assert.equal(wallet.heldBalance, 1000);
    assert.equal(await Transaction.countDocuments({ driverId: driver.user._id, type: "fuel_voucher", amount: 1000 }), 1);
    assert.equal(await Transaction.countDocuments({ driverId: driver.user._id, type: "cash_out", status: "pending" }), 1);
});

test("only staff can redeem a QR voucher, once, by code", async () => {
    const driver = await makeDriver();
    await gold(driver);
    const { body } = await claim(driver, "qr");
    assert.equal((await request(app).patch(`/api/fuel-vouchers/${body.data.id}/redeem`).set(driver.auth)).status, 403);
    const admin = await makePassenger({ role: "admin" });
    const ok = await request(app).post("/api/admin/fuel-vouchers/redeem").set(admin.auth).send({ code: body.data.code.toLowerCase(), station: "Rubis Remera" });
    assert.equal(ok.status, 200, ok.body.message);
    assert.equal(ok.body.data.voucher.status, "redeemed");
    assert.equal((await request(app).post("/api/admin/fuel-vouchers/redeem").set(admin.auth).send({ code: body.data.code })).status, 409);
    const savings = await request(app).get("/api/fuel-vouchers/weekly-savings").set(driver.auth);
    assert.equal(savings.body.data.qrTotal, 1000);
    const list = await request(app).get("/api/admin/fuel-vouchers").set(admin.auth);
    assert.equal(list.body.data.length, 1);
});

test("daily reward vouchers don't use up the driver's own requests", async () => {
    const driver = await makeDriver();
    await gold(driver);
    await User.updateOne({ _id: driver.user._id }, { $push: { fuelVouchers: { $each: [1, 2].map((i) => ({ code: `FUEL-R${i}`, type: "qr", source: "reward", amount: 3000, issuedAt: new Date(), status: "active" })) } } });
    assert.equal((await claim(driver, "qr")).status, 200);
});
