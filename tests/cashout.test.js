// Withdrawals go straight to Paypack. When Paypack refuses (or errors), the
// money stays held, the request waits for staff, and withdrawal managers are
// alerted. The user always sees "received", never a provider error.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makePassenger, makeDriver, fund } = require("./fixtures");

let app, Wallet, WithdrawalRequest, Notification, Transaction, paymentService, realCashOut;
before(async () => {
    app = await startStack();
    Wallet = load("models/Wallet.js"); WithdrawalRequest = load("models/WithdrawalRequest.js");
    Notification = load("models/Notification.js"); Transaction = load("models/Transaction.js");
    paymentService = load("services/paymentService.js"); realCashOut = paymentService.requestCashOut;
});
after(async () => { paymentService.requestCashOut = realCashOut; await stopStack(); });
beforeEach(clearDb);

let seq = 0;
const paypack = (impl) => { paymentService.requestCashOut = impl; };
const accepts = () => paypack(async () => ({ success: true, data: { ref: `po-${++seq}` } }));
const refuses = () => paypack(async () => ({ success: false, error: "Insufficient merchant balance" }));
const withdraw = (who, amount) => request(app).post("/api/wallet/cash-out").set(who.auth)
    .set("Idempotency-Key", `key-${Date.now()}-${++seq}`).send({ amount });
const wallet = async (id) => Wallet.findOne({ driverId: id }).lean();

test("a withdrawal below 10,000 RWF goes straight to Paypack", async () => {
    accepts();
    const driver = await makeDriver();
    await fund(driver.user._id, 10000);
    const res = await withdraw(driver, 3000);
    assert.equal(res.status, 202, res.body.message);
    const saved = await WithdrawalRequest.findById(res.body.data.requestId).lean();
    assert.equal(saved.status, "provider_pending");
    assert.equal(saved.attempts.length, 1);
    assert.equal(saved.attempts[0].ok, true);
    assert.ok(saved.paypackRef);
});

test("Paypack refusal keeps the money held and alerts withdrawal managers only", async () => {
    refuses();
    const driver = await makeDriver();
    const finance = await makePassenger({ role: "financial" });
    const support = await makePassenger({ role: "caller_support" });
    await fund(driver.user._id, 10000);
    const res = await withdraw(driver, 3000);
    assert.equal(res.status, 202, "the user still sees the request as received");
    assert.doesNotMatch(res.body.message, /Paypack|merchant/i, "no provider error shown to the user");

    const saved = await WithdrawalRequest.findById(res.body.data.requestId).lean();
    assert.equal(saved.status, "manual_required");
    assert.equal(saved.attempts[0].ok, false);
    assert.match(saved.attempts[0].reason, /Insufficient merchant balance/);
    assert.ok(saved.alertedAt);
    const w = await wallet(driver.user._id);
    assert.equal(w.balance, 10000 - saved.totalHeld, "not returned to the wallet");
    assert.equal(w.heldBalance, saved.totalHeld, "held for staff");
    const alert = await Notification.findOne({ userId: finance.user._id, title: "Automatic cash-out failed" }).lean();
    assert.ok(alert, "withdrawal managers are alerted");
    assert.match(alert.message, new RegExp(String(driver.user._id)));
    assert.equal(await Notification.countDocuments({ userId: support.user._id, title: "Automatic cash-out failed" }), 0);
    assert.equal((await Transaction.findOne({ reference: String(saved._id), type: "cash_out" })).status, "pending");
});

test("a Paypack network error is treated as a refusal", async () => {
    paypack(async () => { throw new Error("ECONNRESET"); });
    const driver = await makeDriver();
    await fund(driver.user._id, 5000);
    const res = await withdraw(driver, 1000);
    assert.equal(res.status, 202, res.body.message);
    assert.equal((await WithdrawalRequest.findById(res.body.data.requestId)).status, "manual_required");
});
