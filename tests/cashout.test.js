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

// ── Staff handling of refused payouts ────────────────────────────────────
const AuditLog = () => load("models/AuditLog.js");
const staffPost = (who, path, body = {}) => request(app).post(`/api/admin/withdrawals/${path}`).set(who.auth).send(body);
async function refusedWithdrawal(amount = 3000) {
    refuses();
    const driver = await makeDriver();
    await fund(driver.user._id, 10000);
    const res = await withdraw(driver, amount);
    const saved = await WithdrawalRequest.findById(res.body.data.requestId);
    assert.equal(saved.status, "manual_required");
    return { driver, saved };
}

test("paid manually releases the held money once, even when two staff press it together", async () => {
    const { driver, saved } = await refusedWithdrawal();
    const finance = await makePassenger({ role: "financial" });
    const other = await makePassenger({ role: "admin" });
    const [a, b] = await Promise.all([
        staffPost(finance, `${saved._id}/manual-paid`, { reference: "MP2611041234", note: "Paid from MoMo merchant" }),
        staffPost(other, `${saved._id}/manual-paid`, { reference: "MP2611049999", note: "Paid again" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const w = await wallet(driver.user._id);
    assert.equal(w.heldBalance, 0);
    assert.equal(w.balance, 10000 - saved.totalHeld, "money left once");
    const done = await WithdrawalRequest.findById(saved._id).lean();
    assert.equal(done.status, "successful");
    assert.equal(done.manual.action, "paid");
    assert.ok(["MP2611041234", "MP2611049999"].includes(done.manual.reference));
    assert.equal((await Transaction.findOne({ reference: String(saved._id), type: "cash_out" })).status, "successful");
    assert.equal(await AuditLog().countDocuments({ action: "withdrawal_manual_paid", targetId: saved._id }), 1);
});

test("return to wallet gives the held money back", async () => {
    const { driver, saved } = await refusedWithdrawal();
    const finance = await makePassenger({ role: "financial" });
    const res = await staffPost(finance, `${saved._id}/return`, { note: "Number not registered for MoMo" });
    assert.equal(res.status, 200, res.body.message);
    const w = await wallet(driver.user._id);
    assert.equal(w.balance, 10000);
    assert.equal(w.heldBalance, 0);
    const done = await WithdrawalRequest.findById(saved._id).lean();
    assert.equal(done.status, "failed");
    assert.equal(done.manual.action, "returned");
    assert.equal((await Transaction.findOne({ reference: String(saved._id), type: "cash_out" })).status, "failed");
    assert.equal((await staffPost(finance, `${saved._id}/manual-paid`, { reference: "MP123", note: "late" })).status, 409, "a returned request can't be paid");
});

test("retry sends a waiting request to Paypack again", async () => {
    const { saved } = await refusedWithdrawal();
    const finance = await makePassenger({ role: "financial" });
    accepts();
    const res = await staffPost(finance, `${saved._id}/retry`);
    assert.equal(res.status, 200, res.body.message);
    const done = await WithdrawalRequest.findById(saved._id).lean();
    assert.equal(done.status, "provider_pending");
    assert.equal(done.attempts.length, 2);
    assert.equal(done.attempts[1].kind, "retry");
});

test("caller support can neither see nor handle withdrawals", async () => {
    const { saved } = await refusedWithdrawal();
    const support = await makePassenger({ role: "caller_support" });
    assert.equal((await request(app).get("/api/admin/withdrawals").set(support.auth)).status, 403);
    assert.equal((await staffPost(support, `${saved._id}/return`, { note: "trying it" })).status, 403);
    const finance = await makePassenger({ role: "financial" });
    const list = await request(app).get("/api/admin/withdrawals?status=manual_required").set(finance.auth);
    assert.equal(list.status, 200, list.body.message);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].attempts.length, 1, "staff see the attempt history");
});

test("post-deploy migration grants withdrawal access and sends old queued withdrawals", async () => {
    const Role = load("models/Role.js");
    await Role.create({ name: "financial", permissions: ["admin:access", "finance:view", "custom:kept"] });
    const driver = await makeDriver();
    await fund(driver.user._id, 0);
    const old = await WithdrawalRequest.create({ driverId: driver.user._id, amount: 2000, fee: 40, totalHeld: 2040, phone: driver.user.phone, idempotencyKey: "old-queued-1" });
    accepts();
    const { migrate } = load("scripts/migrateCashoutAccess.js");
    const result = await migrate({ log: () => {} });
    assert.equal(result.dispatched, 1);
    const role = await Role.findOne({ name: "financial" }).lean();
    assert.ok(role.permissions.includes("withdrawal:manage"));
    assert.ok(role.permissions.includes("custom:kept"), "existing role edits are kept");
    assert.equal((await WithdrawalRequest.findById(old._id)).status, "provider_pending");
});

test("a request left mid-dispatch by a restart goes to staff with an alert", async () => {
    const driver = await makeDriver();
    const finance = await makePassenger({ role: "financial" });
    await fund(driver.user._id, 0);
    const stuck = await WithdrawalRequest.create({ driverId: driver.user._id, amount: 2000, fee: 40, totalHeld: 2040, phone: driver.user.phone, idempotencyKey: "stuck-1", status: "processing", batchId: "b-stuck" });
    await WithdrawalRequest.collection.updateOne({ _id: stuck._id }, { $set: { updatedAt: new Date(Date.now() - 15 * 60000) } });
    const fresh = await WithdrawalRequest.create({ driverId: driver.user._id, amount: 1000, fee: 20, totalHeld: 1020, phone: driver.user.phone, idempotencyKey: "fresh-1", status: "processing", batchId: "b-fresh" });
    const { recoverStuckDispatches } = load("services/withdrawalService.js");
    assert.equal(await recoverStuckDispatches(), 1);
    const moved = await WithdrawalRequest.findById(stuck._id).lean();
    assert.equal(moved.status, "manual_required");
    assert.match(moved.failureReason, /check Paypack/i, "staff are told to check before paying");
    assert.equal((await WithdrawalRequest.findById(fresh._id)).status, "processing", "a request still being sent is left alone");
    assert.ok(await Notification.findOne({ userId: finance.user._id, title: "Automatic cash-out failed" }));
});
