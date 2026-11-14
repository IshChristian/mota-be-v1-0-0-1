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


// ─── Task 2: admin management ────────────────────────────────────────────────

const staff = async (role) => (await makePassenger({ role, phone: `+25078${String(8000000 + ++seq).slice(-7)}` })).user;
const admin = (user) => ({
    list: (q = {}) => request(app).get("/api/admin/promos").query(q).set(bearer(user)),
    get: (id) => request(app).get(`/api/admin/promos/${id}`).set(bearer(user)),
    create: (body) => request(app).post("/api/admin/promos").set(bearer(user)).send(body),
    update: (id, body) => request(app).patch(`/api/admin/promos/${id}`).set(bearer(user)).send(body),
    remove: (id) => request(app).delete(`/api/admin/promos/${id}`).set(bearer(user)),
});
const uniqueCode = () => `ADM${++seq}${Date.now() % 10000}`;
const validBody = (extra = {}) => ({ code: uniqueCode().toLowerCase(), appliesTo: "ride", discountType: "percent", value: 20, maxUsers: 100, perUserLimit: 1, ...extra });

test("admin creates, lists and edits a code", async () => {
    const boss = admin(await staff("superadmin"));
    const body = validBody();
    const created = await boss.create(body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.code, body.code.toUpperCase());
    const listed = await boss.list({ q: body.code.toUpperCase() });
    assert.equal(listed.status, 200);
    const row = listed.body.data.find((p) => p.code === body.code.toUpperCase());
    assert.ok(row, "listed");
    assert.equal(row.status, "active");
    const edited = await boss.update(created.body.data._id, { value: 30, active: false });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.value, 30);
    assert.equal(edited.body.data.status, "off");
});

test("duplicate code is 409", async () => {
    const boss = admin(await staff("superadmin"));
    const body = validBody();
    await boss.create(body);
    const again = await boss.create({ ...body, code: body.code.toUpperCase() });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "That code already exists.");
});

test("invalid values are 400", async () => {
    const boss = admin(await staff("superadmin"));
    for (const bad of [{ code: "a" }, { code: "BAD CODE!" }, { value: 0 }, { discountType: "percent", value: 120 }, { perUserLimit: 0 }, { maxUsers: 0 }, { appliesTo: "deposit" }, { startsAt: "2026-12-10", endsAt: "2026-12-01" }]) {
        const res = await boss.create(validBody(bad));
        assert.equal(res.status, 400, JSON.stringify(bad));
    }
});

test("code text locked after use", async () => {
    const boss = admin(await staff("superadmin"));
    const p = await newCode();
    await promo.reserve({ code: p.code, appliesTo: "ride", userId: (await passenger())._id, amount: 1500, method: "momo" });
    const res = await boss.update(p._id, { code: "NEWNAME" });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Code and type can't change after the code has been used.");
    assert.equal((await boss.update(p._id, { appliesTo: "registration_fee" })).status, 409);
    assert.equal((await boss.update(p._id, { note: "fine" })).status, 200);
});

test("editing value after use keeps past redemptions' discount", async () => {
    const boss = admin(await staff("superadmin"));
    const p = await newCode({ perUserLimit: 5 });
    const user = await passenger();
    const first = await promo.reserve({ code: p.code, appliesTo: "ride", userId: user._id, amount: 1500, method: "momo" });
    await promo.redeem(first._id);
    await boss.update(p._id, { value: 50 });
    assert.equal((await PromoRedemption.findById(first._id).lean()).discount, 300);
    const q = await promo.quote({ code: p.code, appliesTo: "ride", userId: user._id, amount: 1500 });
    assert.equal(q.discount, 750);
    const detail = await boss.get(p._id);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.redemptions[0].discount, 300);
    assert.ok(detail.body.data.redemptions[0].userId.firstName, "who used it");
});

test("deleting an unused code removes it; a used one is archived", async () => {
    const boss = admin(await staff("superadmin"));
    const unused = await newCode();
    assert.deepEqual((await boss.remove(unused._id)).body, { deleted: true });
    assert.equal(await PromoCode.countDocuments({ _id: unused._id }), 0);
    const used = await newCode();
    await promo.reserve({ code: used.code, appliesTo: "ride", userId: (await passenger())._id, amount: 1500, method: "momo" });
    assert.deepEqual((await boss.remove(used._id)).body, { archived: true });
    const after = await PromoCode.findById(used._id).lean();
    assert.ok(after.archivedAt);
    assert.equal(after.active, false);
    assert.equal((await boss.list()).body.data.some((p) => String(p._id) === String(used._id)), false, "hidden by default");
    assert.equal((await boss.list({ status: "archived" })).body.data.some((p) => String(p._id) === String(used._id)), true);
});

test("financial can view but not create", async () => {
    const finance = admin(await staff("financial"));
    assert.equal((await finance.list()).status, 200);
    assert.equal((await finance.create(validBody())).status, 403);
});

test("a passenger gets 403", async () => {
    assert.equal((await admin(await passenger()).list()).status, 403);
});

test("audit rows are written", async () => {
    const AuditLog = load("models/AuditLog.js");
    const boss = admin(await staff("superadmin"));
    const created = await boss.create(validBody());
    const id = created.body.data._id;
    await boss.update(id, { value: 25 });
    await boss.remove(id);
    const actions = (await AuditLog.find({ targetId: id }).lean()).map((row) => row.action).sort();
    assert.deepEqual(actions, ["promo_created", "promo_deleted", "promo_updated"]);
});

test("permission script adds promo permissions to stored roles", async () => {
    const Role = load("models/Role.js");
    await Role.deleteMany({ name: { $in: ["admin", "financial"] } });
    await Role.create([{ name: "admin", permissions: ["admin:access"] }, { name: "financial", permissions: ["finance:view"] }]).catch(() => null);
    await load("scripts/migratePromoPermissions.js").migrate({ log: () => {} });
    const adminRole = await Role.findOne({ name: "admin" }).lean();
    const financeRole = await Role.findOne({ name: "financial" }).lean();
    assert.ok(adminRole.permissions.includes("promo:manage") && adminRole.permissions.includes("admin:access"));
    assert.ok(financeRole.permissions.includes("promo:view") && !financeRole.permissions.includes("promo:manage"));
});

// ─── Task 3: codes on ride payments ──────────────────────────────────────────

let charged;
let refSeq = 0;
const stubCollections = () => {
    charged = [];
    load("services/paymentService.js").requestCashIn = async (phone, amount) => { charged.push({ phone, amount }); return { success: true, data: { ref: `pr-${++refSeq}-${Date.now()}` } }; };
};
const paypackHook = (ref, amount, status = "successful") => {
    process.env.PAYPACK_WEBHOOK_SECRET = "pp-secret";
    const raw = JSON.stringify({ data: { ref, status, amount, kind: "CASHIN" } });
    const sig = crypto.createHmac("sha256", "pp-secret").update(raw).digest("base64");
    return request(app).post("/api/payment/webhook").set("Content-Type", "application/json").set("x-paypack-signature", sig).send(raw);
};
const payRide = (user, rideId, body = {}) => request(app).post(`/api/rides/${rideId}/pay`).set(bearer(user)).send(body);
const driverEarningOn = async (fare) => (await load("services/walletService.js").calculateCommission(fare)).driverEarning;
const balanceOf = async (id) => (await Wallet.findOne({ driverId: id }).lean())?.balance || 0;

test("MoMo ride with a code charges the discounted amount and pays the driver on the full fare", async () => {
    stubCollections();
    const p = await newCode();
    const user = await passenger();
    const { rideId, driver } = await awaitingRide(user);
    const before = await balanceOf(driver._id);
    const res = await payRide(user, rideId, { promoCode: p.code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(charged[0].amount, 1200);
    assert.equal((await paypackHook(res.body.data.ref, 1200)).status, 200);
    assert.equal(await balanceOf(driver._id) - before, await driverEarningOn(1500));
    const used = await PromoRedemption.findOne({ promoId: p._id }).lean();
    assert.equal(used.status, "redeemed");
    assert.equal(used.discount, 300);
    assert.equal(used.subsidy, 300 - (1500 - await driverEarningOn(1500)));
    assert.equal((await Ride.findById(rideId).lean()).paymentStatus, "successful");
});

test("failed MoMo payment releases the code", async () => {
    stubCollections();
    const p = await newCode({ maxUsers: 1 });
    const user = await passenger();
    const { rideId } = await awaitingRide(user);
    const res = await payRide(user, rideId, { promoCode: p.code });
    await paypackHook(res.body.data.ref, 1200, "failed");
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "released");
    assert.equal((await PromoCode.findById(p._id).lean()).usersCount, 0);
});

test("failed payment can be retried, with or without a code", async () => {
    stubCollections();
    const p = await newCode();
    const user = await passenger();
    const { rideId } = await awaitingRide(user);
    const first = await payRide(user, rideId, { promoCode: p.code });
    await paypackHook(first.body.data.ref, 1200, "failed");
    const second = await payRide(user, rideId, {});
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.data.ref, first.body.data.ref);
    assert.equal(charged.at(-1).amount, 1500);
});

test("same success delivered twice redeems once", async () => {
    stubCollections();
    const p = await newCode();
    const user = await passenger();
    const { rideId, driver } = await awaitingRide(user);
    const before = await balanceOf(driver._id);
    const res = await payRide(user, rideId, { promoCode: p.code });
    await paypackHook(res.body.data.ref, 1200);
    await paypackHook(res.body.data.ref, 1200);
    const after = await PromoCode.findById(p._id).lean();
    assert.equal(after.redeemedCount, 1);
    assert.equal(after.totalDiscount, 300);
    assert.equal(await balanceOf(driver._id) - before, await driverEarningOn(1500));
});

test("code used up between preview and pay: 400 used_up, no prompt", async () => {
    stubCollections();
    const p = await newCode({ maxUsers: 1 });
    const user = await passenger();
    const { rideId } = await awaitingRide(user);
    assert.equal((await preview(user, { code: p.code, appliesTo: "ride", rideId: String(rideId) })).status, 200);
    await promo.reserve({ code: p.code, appliesTo: "ride", userId: (await passenger())._id, amount: 1500, method: "momo" });
    const res = await payRide(user, rideId, { promoCode: p.code });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, "used_up");
    assert.equal(charged.length, 0);
});

test("payment under 100 RWF settles without a prompt", async () => {
    stubCollections();
    const p = await newCode({ discountType: "fixed", value: 1450 });
    const user = await passenger();
    const { rideId, driver } = await awaitingRide(user);
    const before = await balanceOf(driver._id);
    const res = await payRide(user, rideId, { promoCode: p.code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, "successful");
    assert.equal(charged.length, 0);
    assert.equal((await Ride.findById(rideId).lean()).paymentStatus, "successful");
    assert.equal(await balanceOf(driver._id) - before, await driverEarningOn(1500));
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "redeemed");
});

const stopRequestedWalletRide = async (user, fare = 1500) => {
    const { user: driver } = await makeDriver({ online: false });
    const { insertedId } = await Ride.collection.insertOne({
        passengerId: user._id, driverId: driver._id, rideStatus: "stop_requested", paymentMethod: "wallet",
        fare, paymentStatus: "pending", startedAt: new Date(Date.now() - 600000), createdAt: new Date(), updatedAt: new Date(),
    });
    return { rideId: insertedId, driver };
};
const confirmStop = (user, rideId, body = {}) => request(app).post(`/api/rides/${rideId}/confirm-stop`).set(bearer(user)).send(body);

test("wallet ride: preview works at Confirm arrival", async () => {
    const p = await newCode();
    const user = await passenger();
    const { rideId } = await stopRequestedWalletRide(user);
    const res = await preview(user, { code: p.code, appliesTo: "ride", rideId: String(rideId) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.payAmount, 1200);
});

test("wallet ride with a code debits the discounted amount", async () => {
    const p = await newCode();
    const user = await passenger();
    await fund(user._id, 5000);
    const { rideId, driver } = await stopRequestedWalletRide(user);
    const before = await balanceOf(driver._id);
    const res = await confirmStop(user, rideId, { promoCode: p.code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await balanceOf(user._id), 3800);
    assert.equal(await balanceOf(driver._id) - before, await driverEarningOn(1500));
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "redeemed");
});

test("wallet with too little balance: error and code not used", async () => {
    const p = await newCode();
    const user = await passenger();
    await fund(user._id, 500);
    const { rideId } = await stopRequestedWalletRide(user);
    const res = await confirmStop(user, rideId, { promoCode: p.code });
    assert.notEqual(res.status, 200);
    assert.equal(await PromoRedemption.countDocuments({ promoId: p._id }), 0);
    const after = await PromoCode.findById(p._id).lean();
    assert.deepEqual([after.usersCount, after.reservedCount, after.redeemedCount], [0, 0, 0]);
});

test("ride without a code is unchanged", async () => {
    stubCollections();
    const user = await passenger();
    const { rideId } = await awaitingRide(user);
    const res = await payRide(user, rideId);
    assert.equal(res.status, 200);
    assert.equal(charged[0].amount, 1500);
});

// ─── Task 4: codes on the driver registration fee ────────────────────────────

const DriverKyc = () => load("models/DriverKyc.js");
const registerDriver = async (role = "driver") => {
    const res = await request(app).post("/api/auth/register").send({
        firstName: "Fee", lastName: "Driver", phone: `078${String(3000000 + ++seq).slice(-7)}`, nationalId: `1199880${String(100000000 + seq).slice(-9)}`,
        password: "Passw0rd!x", role,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await DriverKyc().updateOne({ userId: res.body.userId }, { status: "submitted" }, { upsert: true, strict: false });
    const user = await User.findById(res.body.userId);
    return { user, token: res.body.token };
};
const payFee = (driver, body, token = driver.token) => {
    const req = request(app).post("/api/auth/pay-registration");
    if (token) req.set("Authorization", `Bearer ${token}`);
    return req.send({ phone: driver.user.phone, ...body });
};
const feeCode = (extra = {}) => newCode({ appliesTo: "registration_fee", ...extra });

test("fee with a code charges the discounted fee", async () => {
    stubCollections();
    const p = await feeCode();
    const driver = await registerDriver();
    const res = await payFee(driver, { promoCode: p.code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(charged[0].amount, 4000);
    await paypackHook(res.body.ref, 4000);
    assert.equal((await User.findById(driver.user._id).lean()).registrationPaid, true);
    const used = await PromoRedemption.findOne({ promoId: p._id }).lean();
    assert.equal(used.status, "redeemed");
    assert.equal(used.subsidy, 0);
    assert.equal(used.discount, 1000);
});

test("fee code needs the driver's session", async () => {
    stubCollections();
    const p = await feeCode();
    const driver = await registerDriver();
    assert.equal((await payFee(driver, { promoCode: p.code }, null)).status, 401);
    assert.equal(charged.length, 0);
});

test("agent gets drivers_only", async () => {
    const p = await feeCode();
    const agent = await User.create({ firstName: "A", lastName: "G", phone: `+25078${String(9000000 + ++seq).slice(-7)}`, role: "agent", isActive: true });
    const res = await request(app).post("/api/auth/pay-registration").set(bearer(agent)).send({ phone: agent.phone, promoCode: p.code });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.reason, "drivers_only");
});

test("100% fee code makes registration free immediately", async () => {
    stubCollections();
    const p = await feeCode({ value: 100 });
    const driver = await registerDriver();
    const res = await payFee(driver, { promoCode: p.code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(charged.length, 0);
    const after = await User.findById(driver.user._id).lean();
    assert.equal(after.registrationPaid, true);
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "redeemed");
});

test("fee code plus another payer number: fee paid, code redeemed, phone not proven", async () => {
    stubCollections();
    const p = await feeCode();
    const driver = await registerDriver();
    const res = await payFee(driver, { promoCode: p.code, payerPhone: "0788999888" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await paypackHook(res.body.ref, 4000);
    const after = await User.findById(driver.user._id).lean();
    assert.equal(after.registrationPaid, true);
    assert.equal(after.isVerified, false);
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "redeemed");
});

test("failed fee payment releases the code", async () => {
    stubCollections();
    const p = await feeCode({ maxUsers: 1 });
    const driver = await registerDriver();
    const res = await payFee(driver, { promoCode: p.code });
    await paypackHook(res.body.ref, 4000, "failed");
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "released");
});

test("registration-status confirming the fee redeems the code", async () => {
    stubCollections();
    const p = await feeCode();
    const driver = await registerDriver();
    const res = await payFee(driver, { promoCode: p.code });
    load("services/paymentService.js").getTransactionStatus = async () => ({ success: true, data: { status: "successful" } });
    const status = await request(app).post("/api/auth/registration-status").set("Authorization", `Bearer ${driver.token}`).send({});
    assert.equal(status.body.paid, true, JSON.stringify(status.body));
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "redeemed");
    assert.ok(res.body.ref);
});

test("cron releases stale reservations", async () => {
    const p = await newCode();
    const held = await promo.reserve({ code: p.code, appliesTo: "ride", userId: (await passenger())._id, amount: 1500, method: "momo" });
    await PromoRedemption.updateOne({ _id: held._id }, { reservedAt: new Date(Date.now() - 31 * 60 * 1000) });
    const cron = load("services/cronService.js");
    assert.equal(typeof cron.releaseStalePromos, "function");
    await cron.releaseStalePromos();
    assert.equal((await PromoRedemption.findById(held._id).lean()).status, "released");
});

// ─── Final review fixes ──────────────────────────────────────────────────────

test("code on a cash ride is refused at pay, with no prompt", async () => {
    stubCollections();
    const p = await newCode();
    const user = await passenger();
    const { rideId } = await awaitingRide(user, { paymentMethod: "cash" });
    const res = await payRide(user, rideId, { promoCode: p.code });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.reason, "wrong_type");
    assert.equal(charged.length, 0);
    assert.equal(await PromoRedemption.countDocuments({ promoId: p._id }), 0);
});

test("a call without the driver's session can't release their held fee code", async () => {
    stubCollections();
    const p = await feeCode({ maxUsers: 1 });
    const driver = await registerDriver();
    await payFee(driver, { promoCode: p.code });
    const anonymous = await request(app).post("/api/auth/pay-registration").send({ phone: driver.user.phone });
    assert.equal(anonymous.status, 409, JSON.stringify(anonymous.body));
    assert.equal(charged.length, 1, "no second prompt");
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "reserved");
    assert.equal((await PromoCode.findById(p._id).lean()).usersCount, 1);
});

test("paying the fee again while the first prompt is still pending is refused and keeps the code", async () => {
    stubCollections();
    const p = await feeCode();
    const driver = await registerDriver();
    await payFee(driver, { promoCode: p.code });
    load("services/paymentService.js").getTransactionStatus = async () => ({ success: true, data: { status: "pending" } });
    const again = await payFee(driver, { promoCode: p.code });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(charged.length, 1);
    assert.equal((await PromoRedemption.findOne({ promoId: p._id }).lean()).status, "reserved");
});

test("paying the fee again after the first prompt failed gives the code back and uses it again", async () => {
    stubCollections();
    const p = await feeCode({ maxUsers: 1 });
    const driver = await registerDriver();
    await payFee(driver, { promoCode: p.code });
    load("services/paymentService.js").getTransactionStatus = async () => ({ success: true, data: { status: "failed" } });
    const again = await payFee(driver, { promoCode: p.code });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(charged.at(-1).amount, 4000);
    const uses = await PromoRedemption.find({ promoId: p._id }).sort({ reservedAt: 1 }).lean();
    assert.deepEqual(uses.map((u) => u.status), ["released", "reserved"]);
    assert.equal((await PromoCode.findById(p._id).lean()).usersCount, 1);
});
