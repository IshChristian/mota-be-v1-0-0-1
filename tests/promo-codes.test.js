// Promo codes: admin-made codes that discount MoMo/wallet ride payments and the driver
// registration fee. MOTA pays the discount; a use counts only when the payment succeeds.
const { test, before, after } = require("node:test");
process.env.FINANCIAL_WRITES_ENABLED = "true"; // ride MoMo payments sit behind the financial write guard
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { startStack, stopStack } = require("./harness");
const { load, makePassenger, makeDriver, fund } = require("./fixtures");

let app, PromoCode, PromoRedemption, promo, User, Ride, Wallet;
let seq = 0;
before(async () => {
    app = await startStack();
    PromoCode = load("models/PromoCode.js");
    PromoRedemption = load("models/PromoRedemption.js");
    promo = load("services/promoService.js");
    User = load("models/User.js");
    Ride = load("models/Ride.js");
    Wallet = load("models/Wallet.js");
});
after(stopStack);

const { generateToken } = load("utils/jwt.js");
const bearer = (user) => ({ Authorization: `Bearer ${generateToken(user)}` });
const newCode = (extra = {}) => PromoCode.create({ code: `T${++seq}X${Date.now() % 100000}`, appliesTo: "ride", discountType: "percent", value: 20, ...extra });
const passenger = async (extra = {}) => (await makePassenger({ phone: `+25078${String(8000000 + ++seq).slice(-7)}`, ...extra })).user;
const awaitingRide = async (rider, { paymentMethod = "momo", fare = 1500 } = {}) => {
    const { user: driver } = await makeDriver({ online: false });
    const { insertedId } = await Ride.collection.insertOne({
        passengerId: rider._id, driverId: driver._id, rideStatus: "awaiting_payment", paymentMethod,
        fare, paymentStatus: "pending", createdAt: new Date(), updatedAt: new Date(),
    });
    return { rideId: insertedId, driver };
};
const preview = (user, body) => request(app).post("/api/promos/preview").set(bearer(user)).send(body);
const reasonOf = async (fn) => { try { await fn(); return null; } catch (e) { return { reason: e.reason, message: e.message, status: e.status }; } };

// ─── Task 1: rules and preview ───────────────────────────────────────────────

test("percent discount with cap", async () => {
    assert.equal(promo.discountFor({ discountType: "percent", value: 20 }, 1500), 300);
    assert.equal(promo.discountFor({ discountType: "percent", value: 20, maxDiscount: 200 }, 1500), 200);
});

test("fixed discount never above the amount", () => {
    assert.equal(promo.discountFor({ discountType: "fixed", value: 2000 }, 1500), 1500);
    assert.equal(promo.discountFor({ discountType: "fixed", value: 500 }, 1500), 500);
});

test("each refusal reason", async () => {
    const user = await passenger();
    const day = 24 * 3600 * 1000;
    const cases = [
        [{ code: "NOPE-NOPE" }, "not_found", "This promo code doesn't exist."],
        [await newCode({ active: false }), "inactive", "This promo code is switched off."],
        [await newCode({ appliesTo: "registration_fee" }), "wrong_type", "This promo code isn't for this payment."],
        [await newCode({ startsAt: new Date(Date.now() + day) }), "not_started", "This promo code isn't active yet."],
        [await newCode({ endsAt: new Date(Date.now() - day) }), "expired", "This promo code has expired."],
        [await newCode({ minAmount: 2000 }), "below_minimum", "This promo code needs a payment of at least 2000 RWF."],
    ];
    for (const [p, reason, message] of cases) {
        const got = await reasonOf(() => promo.quote({ code: p.code, appliesTo: "ride", userId: user._id, amount: 1500 }));
        assert.deepEqual(got, { reason, message, status: 400 }, p.code);
    }
    const full = await newCode({ maxUsers: 1 });
    await promo.reserve({ code: full.code, appliesTo: "ride", userId: (await passenger())._id, amount: 1500, method: "momo" });
    assert.equal((await reasonOf(() => promo.quote({ code: full.code, appliesTo: "ride", userId: user._id, amount: 1500 }))).reason, "used_up");
    const once = await newCode();
    await promo.reserve({ code: once.code, appliesTo: "ride", userId: user._id, amount: 1500, method: "momo" });
    assert.deepEqual(await reasonOf(() => promo.quote({ code: once.code, appliesTo: "ride", userId: user._id, amount: 1500 })), { reason: "already_used", message: "You've already used this promo code.", status: 400 });
});

test("codes are case-insensitive", async () => {
    const p = await newCode();
    const user = await passenger();
    const q = await promo.quote({ code: ` ${p.code.toLowerCase()} `, appliesTo: "ride", userId: user._id, amount: 1500 });
    assert.equal(q.payAmount, 1200);
});

test("preview returns the discounted price", async () => {
    const p = await newCode();
    const user = await passenger();
    const { rideId } = await awaitingRide(user);
    const res = await preview(user, { code: p.code, appliesTo: "ride", rideId: String(rideId) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { code: p.code, discount: 300, payAmount: 1200, originalAmount: 1500 });
});

test("preview refuses a cash ride", async () => {
    const p = await newCode();
    const user = await passenger();
    const { rideId } = await awaitingRide(user, { paymentMethod: "cash" });
    const res = await preview(user, { code: p.code, appliesTo: "ride", rideId: String(rideId) });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, "wrong_type");
});

test("preview reserves nothing", async () => {
    const p = await newCode({ maxUsers: 1 });
    const user = await passenger();
    const { rideId } = await awaitingRide(user);
    await preview(user, { code: p.code, appliesTo: "ride", rideId: String(rideId) });
    const after = await PromoCode.findById(p._id).lean();
    assert.equal(after.usersCount, 0);
    assert.equal(after.reservedCount, 0);
    assert.equal(await PromoRedemption.countDocuments({ promoId: p._id }), 0);
});

test("maxUsers: a third person is refused, an existing person can use remaining uses", async () => {
    const p = await newCode({ maxUsers: 2, perUserLimit: 2 });
    const [a, b, c] = [await passenger(), await passenger(), await passenger()];
    const r = (u) => promo.reserve({ code: p.code, appliesTo: "ride", userId: u._id, amount: 1500, method: "momo" });
    await r(a); await r(b);
    assert.equal((await reasonOf(() => r(c))).reason, "used_up");
    await r(a); // A already holds a place
    assert.equal((await reasonOf(() => r(a))).reason, "already_used");
    assert.equal((await PromoCode.findById(p._id).lean()).usersCount, 2);
});

test("last place taken concurrently: only one succeeds", async () => {
    const p = await newCode({ maxUsers: 1 });
    const [a, b] = [await passenger(), await passenger()];
    const results = await Promise.allSettled([a, b].map((u) => promo.reserve({ code: p.code, appliesTo: "ride", userId: u._id, amount: 1500, method: "momo" })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await PromoCode.findById(p._id).lean()).usersCount, 1);
});

test("same person double-tapping holds one use and one place", async () => {
    const p = await newCode({ maxUsers: 3 });
    const a = await passenger();
    const results = await Promise.allSettled([1, 2].map(() => promo.reserve({ code: p.code, appliesTo: "ride", userId: a._id, amount: 1500, method: "momo" })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const after = await PromoCode.findById(p._id).lean();
    assert.equal(after.usersCount, 1);
    assert.equal(after.reservedCount, 1);
});

test("release frees a person's place", async () => {
    const p = await newCode({ maxUsers: 1 });
    const [a, b] = [await passenger(), await passenger()];
    const held = await promo.reserve({ code: p.code, appliesTo: "ride", userId: a._id, amount: 1500, method: "momo" });
    assert.equal(await promo.release(held._id), true);
    await promo.reserve({ code: p.code, appliesTo: "ride", userId: b._id, amount: 1500, method: "momo" });
    const after = await PromoCode.findById(p._id).lean();
    assert.equal(after.usersCount, 1);
    assert.equal(after.reservedCount, 1);
});

test("stale reservation without a ref is released after 30 minutes; one with a ref is kept", async () => {
    const p = await newCode({ maxUsers: 5 });
    const [a, b] = [await passenger(), await passenger()];
    const noRef = await promo.reserve({ code: p.code, appliesTo: "ride", userId: a._id, amount: 1500, method: "momo" });
    const withRef = await promo.reserve({ code: p.code, appliesTo: "ride", userId: b._id, amount: 1500, method: "momo" });
    await promo.attachPaymentRef(withRef._id, "ref-pending-1");
    await PromoRedemption.updateMany({ _id: { $in: [noRef._id, withRef._id] } }, { reservedAt: new Date(Date.now() - 31 * 60 * 1000) });
    assert.equal(await promo.releaseStale(), 1);
    assert.equal((await PromoRedemption.findById(noRef._id).lean()).status, "released");
    assert.equal((await PromoRedemption.findById(withRef._id).lean()).status, "reserved");
});

test("redeem is idempotent", async () => {
    const p = await newCode();
    const user = await passenger();
    const held = await promo.reserve({ code: p.code, appliesTo: "ride", userId: user._id, amount: 1500, method: "momo" });
    assert.equal(await promo.redeem(held._id, { subsidy: 150 }), true);
    assert.equal(await promo.redeem(held._id, { subsidy: 150 }), false);
    const after = await PromoCode.findById(p._id).lean();
    assert.deepEqual([after.reservedCount, after.redeemedCount, after.totalDiscount, after.subsidyTotal], [0, 1, 300, 150]);
});

module.exports = { newCode, passenger, awaitingRide, bearer };
