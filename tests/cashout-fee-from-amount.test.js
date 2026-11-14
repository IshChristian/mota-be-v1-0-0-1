// The cash-out fee comes out of the amount the user asks for: withdrawing
// 7,000 RWF takes 7,000 from the wallet, sends 6,860 to MoMo and the 140 fee
// is MOTA's. Before, the wallet lost 7,140 and MoMo got 7,000.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makeDriver, fund } = require("./fixtures");

let app, Wallet, WithdrawalRequest, Transaction, paymentService, withdrawalService, realCashOut, sent;
before(async () => {
    app = await startStack();
    Wallet = load("models/Wallet.js"); WithdrawalRequest = load("models/WithdrawalRequest.js");
    Transaction = load("models/Transaction.js");
    paymentService = load("services/paymentService.js"); realCashOut = paymentService.requestCashOut;
    withdrawalService = load("services/withdrawalService.js");
});
after(async () => { paymentService.requestCashOut = realCashOut; await stopStack(); });
beforeEach(async () => {
    await clearDb();
    sent = [];
    let n = 0;
    paymentService.requestCashOut = async (phone, amount) => { sent.push(amount); return { success: true, data: { ref: `fee-${Date.now()}-${++n}` } }; };
});

const PASSWORD_HASH = require("bcrypt").hashSync("Driver!pass1", 4);
let seq = 0;
const withdraw = async (who, amount) => {
    await load("models/User.js").updateOne({ _id: who.user._id }, { password: PASSWORD_HASH });
    return request(app).post("/api/wallet/cash-out").set(who.auth)
        .set("Idempotency-Key", `feekey-${Date.now()}-${++seq}`).send({ amount, phone: who.user.phone, password: "Driver!pass1" });
};
const wallet = async (id) => Wallet.findOne({ driverId: id }).lean();

test("withdrawing 7,000 takes 7,000 from the wallet and pays 6,860 to MoMo", async () => {
    const driver = await makeDriver();
    await fund(driver.user._id, 10000);
    const res = await withdraw(driver, 7000);
    assert.equal(res.status, 202, res.body.message);
    assert.equal(res.body.data.requestedAmount, 7000);
    assert.equal(res.body.data.fee, 140);
    assert.equal(res.body.data.payoutAmount, 6860);
    assert.deepEqual(sent, [6860], "Paypack sends the amount after the fee");

    let w = await wallet(driver.user._id);
    assert.equal(w.balance, 3000, "only the requested 7,000 leaves the balance");
    assert.equal(w.heldBalance, 7000);

    const saved = await WithdrawalRequest.findById(res.body.data.requestId).lean();
    assert.equal(saved.amount, 6860);
    assert.equal(saved.fee, 140);
    assert.equal(saved.totalHeld, 7000);

    await withdrawalService.settleWebhook(saved.paypackRef, "successful", "CASHOUT", 6860, { ok: true });
    w = await wallet(driver.user._id);
    assert.equal(w.balance, 3000);
    assert.equal(w.heldBalance, 0);
    const rows = await Transaction.find({ reference: String(saved._id) }).lean();
    const cashOut = rows.find((r) => r.type === "cash_out");
    const fee = rows.find((r) => r.type === "cash_out_fee");
    assert.equal(cashOut.amount, -6860);
    assert.equal(cashOut.status, "successful");
    assert.equal(fee.amount, -140, "MOTA's fee is recorded");
    assert.equal(cashOut.amount + fee.amount, -7000, "the wallet history adds up to what was asked");
});

test("the whole balance can be withdrawn (no extra fee on top)", async () => {
    const driver = await makeDriver();
    await fund(driver.user._id, 7000);
    const res = await withdraw(driver, 7000);
    assert.equal(res.status, 202, res.body.message);
    assert.deepEqual(sent, [6860]);
    assert.equal((await wallet(driver.user._id)).balance, 0);
});

test("a failed payout returns the full requested amount", async () => {
    const driver = await makeDriver();
    await fund(driver.user._id, 10000);
    const res = await withdraw(driver, 7000);
    const saved = await WithdrawalRequest.findById(res.body.data.requestId).lean();
    await withdrawalService.settleWebhook(saved.paypackRef, "failed", "CASHOUT", 6860, { ok: false });
    const w = await wallet(driver.user._id);
    assert.equal(w.balance, 10000);
    assert.equal(w.heldBalance, 0);
    assert.equal(await Transaction.countDocuments({ type: "cash_out_fee" }), 0, "no fee when nothing was paid");
});

test("an amount too small to leave 100 RWF after the fee is refused", async () => {
    const driver = await makeDriver();
    await fund(driver.user._id, 10000);
    const res = await withdraw(driver, 101);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /at least 102 RWF/);
    assert.deepEqual(sent, []);
    assert.equal((await wallet(driver.user._id)).balance, 10000);
});
