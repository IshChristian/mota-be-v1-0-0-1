const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startStack, stopStack, clearDb } = require("./harness");
const request = require("supertest");
const axios = require("axios");
const { load, makePassenger } = require("./fixtures");

let app, Wallet, Transaction;
before(async () => {
    app = await startStack();
    Wallet = load("models/Wallet.js"); Transaction = load("models/Transaction.js");
    process.env.PAYMENT_PROVIDER = "paystack";
    process.env.PAYSTACK_SECRET_KEY = "sk_test_mota";
});
after(async () => { delete process.env.PAYMENT_PROVIDER; await stopStack(); });
beforeEach(clearDb);

const sign = (body) => crypto.createHmac("sha512", "sk_test_mota").update(body).digest("hex");
const hook = (body, sig = sign(body)) => request(app).post("/api/payment/webhook/paystack").set("Content-Type", "application/json").set("x-paystack-signature", sig).send(body);

test("wallet top-up via Paystack mobile money settles once from a signed webhook", async (t) => {
    const calls = [];
    t.mock.method(axios, "create", () => ({ post: async (path, body) => { calls.push({ path, body }); return { data: { data: { status: "pay_offline" } } }; } }));
    const user = await makePassenger({ phone: "+250788555111" });
    const res = await request(app).post("/api/wallet/cash-in").set(user.auth).set("Idempotency-Key", "paystack-topup-1").send({ amount: 2000, phone: "0788555111" });
    assert.ok([200, 201, 202].includes(res.status), res.body.message);
    assert.equal(calls[0].path, "/charge");
    assert.equal(calls[0].body.amount, 200000, "amount sent in subunits");
    assert.deepEqual(calls[0].body.mobile_money, { phone: "0788555111", provider: "mtn" });
    const tx = await Transaction.findOne({ driverId: user.user._id, type: "cash_in" });
    assert.match(tx.paypackRef, /^MOTA-IN-/);

    const body = JSON.stringify({ event: "charge.success", data: { reference: tx.paypackRef, amount: 200000, status: "success" } });
    assert.equal((await hook(body, "forged")).status, 401);
    assert.equal((await hook(body)).status, 200);
    assert.equal((await Wallet.findOne({ driverId: user.user._id })).balance, 2000);
    await hook(body);
    assert.equal((await Wallet.findOne({ driverId: user.user._id })).balance, 2000, "replayed webhook is a no-op");
});

test("unknown Paystack events are acknowledged without changes; phone networks are detected", async () => {
    const body = JSON.stringify({ event: "customeridentification.success", data: { reference: "x" } });
    assert.equal((await hook(body)).status, 200);
    const { parsePhone } = load("services/paystackProvider.js");
    assert.equal(parsePhone("+250788123456").network, "mtn");
    assert.equal(parsePhone("0722123456").network, "airtel");
    assert.equal(parsePhone("0700000000").network, null);
});
