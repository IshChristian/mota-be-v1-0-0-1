// Ride commission must move money, not just appear on screen: whatever the
// driver was shown as "commission" leaves their wallet, the ledger rows add up
// to the balance change, and the platform revenue report counts it once.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makePassenger, makeDriver, fund, requestRide } = require("./fixtures");

let app, Ride, Wallet, Transaction, walletService, algorithmService;
before(async () => {
    app = await startStack();
    Ride = load("models/Ride.js"); Wallet = load("models/Wallet.js"); Transaction = load("models/Transaction.js");
    walletService = load("services/walletService.js"); algorithmService = load("services/algorithmService.js");
});
after(stopStack);
beforeEach(clearDb);

const post = (path, who, body = {}) => request(app).post(path).set(who.auth).send(body);
const balanceOf = async (userId) => (await Wallet.findOne({ driverId: userId }))?.balance ?? 0;
const rows = (filter) => Transaction.find(filter).sort({ createdAt: 1 }).lean();
const ledgerSum = async (driverId, rideId) => (await rows({ driverId, rideId, status: "successful" })).reduce((s, t) => s + t.amount, 0);

async function runToAwaitingPayment(passenger, driver, id) {
    for (const [path, who] of [["accept", driver], ["arrived", driver], ["request-start", driver], ["confirm-start", passenger], ["request-stop", driver], ["confirm-stop", passenger]]) {
        const res = await post(`/api/rides/${id}/${path}`, who);
        assert.equal(res.status, 200, `${path}: ${res.body.message}`);
    }
}

test("cash ride: the commission shown to the driver is taken from their wallet, once", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    await fund(driver.user._id, 5000);
    const id = (await requestRide(app, passenger, { paymentMethod: "cash" })).body.data.rideId;
    await runToAwaitingPayment(passenger, driver, id);
    const shown = (await Ride.findById(id)).commissionAmount;
    assert.ok(shown > 0, "driver was shown a commission");

    const [a, b] = await Promise.all([post(`/api/rides/${id}/claim-fare`, driver), post(`/api/rides/${id}/claim-fare`, driver)]);
    assert.equal(a.status, 200, a.body.message);
    assert.equal(b.status, 200, b.body.message);

    assert.equal(await balanceOf(driver.user._id), 5000 - shown, "commission left the driver wallet");
    const charged = await rows({ rideId: id, type: "platform_commission" });
    assert.equal(charged.length, 1, "retries don't double-charge");
    assert.equal(charged[0].status, "successful");
    assert.equal(charged[0].amount, -shown);
    assert.equal(await balanceOf(passenger.user._id), 0, "a cash passenger's wallet is untouched");
    assert.equal((await algorithmService.calculateRevenue()).fares_commission, shown, "platform revenue counts it");
});

test("cash ride with an empty wallet: commission stays owed and is collected from the next money in", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const id = (await requestRide(app, passenger, { paymentMethod: "cash" })).body.data.rideId;
    await runToAwaitingPayment(passenger, driver, id);
    assert.equal((await post(`/api/rides/${id}/claim-fare`, driver)).status, 200);
    const owed = (await Ride.findById(id)).commissionAmount;

    assert.equal(await balanceOf(driver.user._id), 0, "balance never goes negative");
    const [pending] = await rows({ rideId: id, type: "platform_commission" });
    assert.equal(pending.status, "pending");
    assert.equal(pending.amount, -owed);

    // Part of it from a small top-up, the rest from the next one.
    const part = Math.floor(owed / 2);
    await walletService.creditWallet(driver.user._id, part, "admin_credit");
    assert.equal(await balanceOf(driver.user._id), 0);
    await walletService.creditWallet(driver.user._id, 1000, "admin_credit");
    assert.equal(await balanceOf(driver.user._id), part + 1000 - owed);
    const all = await rows({ rideId: id, type: "platform_commission" });
    assert.ok(all.every((t) => t.status === "successful"), "nothing left owed");
    assert.equal(all.reduce((s, t) => s + t.amount, 0), -owed, "collected exactly the commission");
});

test("wallet ride: passenger pays the fare, driver gets fare minus the commission, ledger matches", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    await fund(passenger.user._id, 20000);
    const res = await requestRide(app, passenger, { paymentMethod: "wallet" });
    assert.equal(res.status, 201, res.body.message);
    const id = res.body.data.rideId;
    await runToAwaitingPayment(passenger, driver, id);
    const ride = await Ride.findById(id);
    assert.equal(ride.paymentStatus, "successful");

    assert.equal(await balanceOf(passenger.user._id), 20000 - ride.fare);
    assert.equal(await balanceOf(driver.user._id), ride.fare - ride.commissionAmount);
    assert.equal(await ledgerSum(driver.user._id, id), ride.fare - ride.commissionAmount, "driver rows add up to the balance change");
    const [commission] = await rows({ rideId: id, type: "platform_commission" });
    assert.equal(commission.amount, -ride.commissionAmount);
    assert.equal((await algorithmService.calculateRevenue()).fares_commission, ride.commissionAmount);
});

test("MoMo ride: Paypack confirmation credits fare minus commission once, even when replayed", async () => {
    process.env.PAYPACK_WEBHOOK_VERIFY = "false";
    const driver = await makeDriver();
    const ride = await Ride.create({ driverId: driver.user._id, passengerPhone: "+250788000111", fare: 3000, commissionAmount: 300, driverEarning: 2700, paymentMethod: "momo", paymentStatus: "pending", rideStatus: "awaiting_payment" });
    await Transaction.create({ driverId: driver.user._id, rideId: ride._id, amount: 3000, type: "cash_in", status: "pending", paypackRef: "ref-ride-1" });
    const event = { data: { ref: "ref-ride-1", status: "successful", amount: 3000, kind: "CASHIN" } };

    const [a, b] = await Promise.all([request(app).post("/api/payment/webhook").send(event), request(app).post("/api/payment/webhook").send(event)]);
    assert.equal(a.status, 200, a.body.message);
    assert.equal(b.status, 200, b.body.message);

    assert.equal(await balanceOf(driver.user._id), 2700);
    assert.equal(await ledgerSum(driver.user._id, ride._id), 2700, "fare in, commission out, nothing double-counted");
    const charged = await rows({ rideId: ride._id, type: "platform_commission" });
    assert.equal(charged.length, 1);
    assert.equal(charged[0].amount, -300);
    assert.equal((await Ride.findById(ride._id)).paymentStatus, "successful");
});

test("an admin commission change does not alter what an accepted ride shows or charges", async () => {
    const configService = load("services/configService.js");
    const passenger = await makePassenger();
    const driver = await makeDriver();
    await fund(driver.user._id, 5000);
    const id = (await requestRide(app, passenger, { paymentMethod: "cash" })).body.data.rideId;
    await runToAwaitingPayment(passenger, driver, id);
    const shownAtAccept = (await Ride.findById(id)).commissionAmount;
    await configService.setConfig("ride_commission_percentage", 25, "test");

    const view = await request(app).get(`/api/rides/${id}`).set(driver.auth);
    assert.equal(view.status, 200, view.body.message);
    assert.equal(view.body.data.ride.commissionAmount, shownAtAccept, "driver screen keeps the accepted commission");
    assert.equal((await post(`/api/rides/${id}/claim-fare`, driver)).status, 200);
    assert.equal(await balanceOf(driver.user._id), 5000 - shownAtAccept, "and that is what is charged");
});
