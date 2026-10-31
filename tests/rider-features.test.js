const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startStack, stopStack, clearDb } = require("./harness");
const request = require("supertest");
const { load, makePassenger, makeDriver, fund, requestRide, wait, KIMIHURURA, REMERA } = require("./fixtures");

let app, Ride, Wallet, SmsLog, Notification;
before(async () => {
    app = await startStack();
    Ride = load("models/Ride.js"); Wallet = load("models/Wallet.js"); SmsLog = load("models/SmsLog.js"); Notification = load("models/Notification.js");
});
after(stopStack);
beforeEach(clearDb);

const post = (path, who, body = {}) => request(app).post(path).set(who.auth).send(body);
const get = (path, who) => request(app).get(path).set(who.auth);

test("estimate without vehicleType prices moto and car; old clients still get top-level moto fields", async () => {
    const res = await request(app).post("/api/rides/estimate").send({ pickup: KIMIHURURA, destination: REMERA });
    assert.equal(res.status, 200, res.body.message);
    const [motor, car] = res.body.data.options;
    assert.equal(motor.vehicleType, "motor");
    assert.equal(car.vehicleType, "car");
    assert.ok(car.suggestedFare > motor.suggestedFare);
    assert.equal(res.body.suggestedFare, motor.suggestedFare, "backwards compatible");
});

test("active ride restore, PIN only for passenger, and car rides reach only car drivers", async () => {
    const passenger = await makePassenger();
    const moto = await makeDriver({ vehicleType: "moto" });
    const car = await makeDriver({ vehicleType: "car" });
    const res = await requestRide(app, passenger, { vehicleType: "car", passengers: 3 });
    assert.equal(res.status, 201, res.body.message);
    assert.equal(res.body.data.notifiedDrivers, 1);
    const ride = await Ride.findById(res.body.data.rideId);
    assert.deepEqual(ride.notifiedDrivers.map(String), [String(car.user._id)]);
    assert.equal((await post(`/api/rides/${ride._id}/accept`, moto)).status, 400, "moto driver was never offered it");

    const active = await get("/api/rides/active", passenger);
    assert.equal(active.status, 200);
    assert.equal(active.body.data.rideStatus, "searching");
    assert.match(active.body.data.ridePin, /^\d{4}$/);
    assert.equal(active.body.data.vehicleType, "car");

    assert.equal((await post(`/api/rides/${ride._id}/accept`, car)).status, 200);
    const asDriver = await get(`/api/rides/${ride._id}`, car);
    assert.equal(asDriver.body.data.ride.ridePin, undefined, "driver never receives the PIN");
    assert.equal((await requestRide(app, passenger)).status, 409, "one active ride at a time");
});

test("request validation: passengers per vehicle, payment method, parcel size", async () => {
    const passenger = await makePassenger();
    assert.equal((await requestRide(app, passenger, { passengers: 2 })).status, 400, "moto takes one passenger");
    assert.equal((await requestRide(app, passenger, { vehicleType: "car", passengers: 5 })).status, 400);
    assert.equal((await requestRide(app, passenger, { vehicleType: "bus" })).status, 400);
    assert.equal((await requestRide(app, passenger, { paymentMethod: "bitcoin" })).status, 400);
    assert.equal((await requestRide(app, passenger, { rideType: "parcel", parcel: { recipientName: "Eric", recipientPhone: "0788123456", size: "large" } })).status, 400, "large parcel needs a car");
    const wallet = await requestRide(app, passenger, { paymentMethod: "wallet" });
    assert.equal(wallet.status, 402);
    assert.equal(wallet.body.code, "INSUFFICIENT_WALLET_BALANCE");
});

test("raise offer, driver counter-offer, passenger accepts → driver told and assigned", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const res = await requestRide(app, passenger);
    const id = res.body.data.rideId;
    const ride = await Ride.findById(id);
    const raise = await post(`/api/rides/${id}/raise-offer`, passenger, { amount: ride.fare + 100 });
    assert.equal(raise.status, 200, raise.body.message);
    assert.equal(raise.body.data.fare, ride.fare + 100);
    assert.equal((await post(`/api/rides/${id}/raise-offer`, passenger, { amount: ride.fare })).status, 400, "cannot lower");

    const counter = await post(`/api/rides/${id}/counter-offer`, driver, { amount: Math.min(ride.maximumFare, ride.fare + 200) });
    assert.equal(counter.status, 200, counter.body.message);
    assert.equal((await post(`/api/rides/${id}/counter-offer`, driver, { amount: ride.maximumFare })).status, 409, "one counter per driver");
    const accept = await post(`/api/rides/${id}/counter-offers/${counter.body.data._id}/accept`, passenger);
    assert.equal(accept.status, 200, accept.body.message);
    const after = await Ride.findById(id);
    assert.equal(String(after.driverId), String(driver.user._id));
    assert.equal(after.rideStatus, "approaching");
    assert.equal(after.fare, counter.body.data.amount);
    assert.ok(await Notification.exists({ userId: driver.user._id, "metadata.rideId": after._id, title: "Your price was accepted" }));
});

async function runToAwaitingPayment(passenger, driver, id, deliveryPin) {
    for (const [path, who, body] of [["accept", driver], ["arrived", driver], ["request-start", driver], ["confirm-start", passenger], ["request-stop", driver, deliveryPin ? { deliveryPin } : {}], ["confirm-stop", passenger]]) {
        const res = await post(`/api/rides/${id}/${path}`, who, body);
        assert.equal(res.status, 200, `${path}: ${res.body.message}`);
    }
}

test("parcel delivery: recipient gets an SMS code and the rider needs it to finish", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const res = await requestRide(app, passenger, { rideType: "parcel", parcel: { recipientName: "Eric", recipientPhone: "0788123456", description: "Documents", size: "small" } });
    assert.equal(res.status, 201, res.body.message);
    const id = res.body.data.rideId;
    const sms = await SmsLog.findOne({ phone: "+250788123456" });
    const code = sms?.message.match(/code (\d{4})/)?.[1];
    assert.ok(code, "recipient was sent a code");
    for (const [path, who] of [["accept", driver], ["arrived", driver], ["request-start", driver], ["confirm-start", passenger]]) await post(`/api/rides/${id}/${path}`, who);
    assert.equal((await post(`/api/rides/${id}/request-stop`, driver, { deliveryPin: "0000" })).status, 400);
    assert.equal((await post(`/api/rides/${id}/request-stop`, driver, { deliveryPin: code })).status, 200);
    assert.ok((await Ride.findById(id)).parcel.deliveredAt);
});

test("tip from wallet after rating moves money passenger → driver", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    await fund(passenger.user._id, 20000);
    const res = await requestRide(app, passenger, { paymentMethod: "wallet" });
    const id = res.body.data.rideId;
    await runToAwaitingPayment(passenger, driver, id);
    const claim = await post(`/api/rides/${id}/claim-fare`, driver);
    assert.equal(claim.status, 200, claim.body.message);
    const before = (await Wallet.findOne({ driverId: driver.user._id })).balance;
    const rate = await post(`/api/rides/${id}/rating`, passenger, { rating: 5, comment: "Great", tip: 500 });
    assert.equal(rate.status, 200, rate.body.message);
    assert.equal(rate.body.tipError, undefined);
    assert.equal((await Wallet.findOne({ driverId: driver.user._id })).balance, before + 500);
    const view = await get(`/api/rides/${id}`, passenger);
    assert.equal(view.body.data.ride.tipAmount, 500);
    assert.equal(view.body.data.ride.driver.rating, 5);
});

test("trip share link: safe public view that dies with the ride", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const { body } = await requestRide(app, passenger);
    const id = body.data.rideId;
    await post(`/api/rides/${id}/accept`, driver);
    const share = await post(`/api/rides/${id}/share`, passenger);
    assert.equal(share.status, 200, share.body.message);
    assert.match(share.body.data.url, /^https:\/\/mota\.test\/share\//);
    const pub = await request(app).get(`/api/share/${share.body.data.token}`);
    assert.equal(pub.status, 200);
    const text = JSON.stringify(pub.body);
    assert.ok(!text.includes(passenger.user.phone) && !text.includes(driver.user.phone), "no phone numbers");
    const html = await request(app).get(`/share/${share.body.data.token}`);
    assert.match(html.text, /Driver on the way/);
    await post(`/api/rides/${id}/cancel`, passenger, { reason: "Changed plans" });
    assert.equal((await request(app).get(`/api/share/${share.body.data.token}`)).status, 404);
});

test("SOS texts every emergency contact with a live link", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    assert.equal((await post("/api/users/me/emergency-contacts", passenger, { name: "Mama", phone: "0788000111" })).status, 201);
    assert.equal((await post("/api/users/me/emergency-contacts", passenger, { name: "Papa", phone: "0722000222" })).status, 201);
    assert.equal((await post("/api/users/me/emergency-contacts", passenger, { name: "Me", phone: passenger.user.phone })).status, 400);
    const { body } = await requestRide(app, passenger);
    await post(`/api/rides/${body.data.rideId}/accept`, driver);
    const sos = await post("/api/production/safety-events", passenger, { rideId: body.data.rideId, type: "sos", category: "active_ride", location: { latitude: -1.95, longitude: 30.1 } });
    assert.equal(sos.status, 201, sos.body.message);
    assert.equal(sos.body.data.contactsAttempted, 2);
    assert.ok(sos.body.data.shareUrl);
    const texts = await SmsLog.find({ type: "sos_alert" });
    assert.equal(texts.length, 2);
    assert.match(texts[0].message, /mota\.test\/share\//);
});

test("chat between rider and driver only, and call info during a live ride", async () => {
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const { body } = await requestRide(app, passenger);
    const id = body.data.rideId;
    assert.equal((await post(`/api/rides/${id}/messages`, passenger, { text: "hi" })).status, 404, "no chat before a driver accepts");
    await post(`/api/rides/${id}/accept`, driver);
    assert.equal((await post(`/api/rides/${id}/messages`, passenger, { text: "I'm at the gate" })).status, 201);
    assert.equal((await post(`/api/rides/${id}/messages`, driver, { text: "2 minutes" })).status, 201);
    const list = await get(`/api/rides/${id}/messages`, driver);
    assert.deepEqual(list.body.data.map((m) => m.text), ["I'm at the gate", "2 minutes"]);
    assert.equal((await get(`/api/rides/${id}/messages`, await makePassenger())).status, 404);
    const call = await post(`/api/rides/${id}/call`, passenger);
    assert.equal(call.body.data.phone, driver.user.phone);
});

test("saved places and recent destinations", async () => {
    const passenger = await makePassenger();
    assert.equal((await post("/api/users/me/places", passenger, { label: "Home", name: "Kimihurura", latitude: -1.95, longitude: 30.09 })).status, 201);
    const upd = await post("/api/users/me/places", passenger, { label: "home", name: "Kacyiru", latitude: -1.94, longitude: 30.07 });
    assert.equal(upd.body.data.length, 1, "same label replaces");
    const places = await get("/api/users/me/places", passenger);
    assert.equal(places.body.data.saved[0].name, "Kacyiru");
    assert.deepEqual(places.body.data.recent, []);
});

test("unanswered requests are re-offered to new drivers, then expire", async () => {
    const { expireStaleRequests } = load("services/rideEngineService.js");
    const passenger = await makePassenger();
    await makeDriver();
    const { body } = await requestRide(app, passenger);
    const id = body.data.rideId;
    const late = await makeDriver();
    await Ride.updateOne({ _id: id }, { $set: { lastDispatchAt: new Date(Date.now() - 120000) } });
    await expireStaleRequests();
    assert.ok((await Ride.findById(id)).notifiedDrivers.map(String).includes(String(late.user._id)));
    await Ride.updateOne({ _id: id }, { $set: { requestedAt: new Date(Date.now() - 60 * 60000) } });
    assert.equal(await expireStaleRequests(), 1);
    assert.equal((await Ride.findById(id)).rideStatus, "expired");
});

test("nearby drivers are coarse, anonymous and filterable by vehicle", async () => {
    const passenger = await makePassenger();
    await makeDriver({ vehicleType: "moto" });
    await makeDriver({ vehicleType: "car" });
    const all = await get(`/api/realtime/nearby-drivers?lat=${KIMIHURURA.latitude}&lng=${KIMIHURURA.longitude}`, passenger);
    assert.equal(all.body.data.length, 2);
    assert.equal(all.body.data[0].firstName, undefined);
    assert.ok(String(all.body.data[0].latitude).split(".")[1].length <= 3);
    const cars = await get(`/api/realtime/nearby-drivers?lat=${KIMIHURURA.latitude}&lng=${KIMIHURURA.longitude}&vehicleType=car`, passenger);
    assert.equal(cars.body.data.length, 1);
});

test("place search endpoint validates and degrades gracefully", async () => {
    const passenger = await makePassenger();
    const short = await get("/api/maps/search?q=ab", passenger);
    assert.equal(short.status, 200);
    assert.deepEqual(short.body.data, []);
    assert.equal((await get("/api/maps/reverse?lat=x&lng=1", passenger)).status, 400);
});

test("cash ride: driver confirms cash, commission recorded as owed exactly once", async () => {
    const Transaction = load("models/Transaction.js");
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const res = await requestRide(app, passenger, { paymentMethod: "cash" });
    const id = res.body.data.rideId;
    await runToAwaitingPayment(passenger, driver, id);
    const [a, b] = await Promise.all([post(`/api/rides/${id}/claim-fare`, driver), post(`/api/rides/${id}/claim-fare`, driver)]);
    assert.equal(a.status, 200, a.body.message);
    assert.equal(b.status, 200, b.body.message);
    const ride = await Ride.findById(id);
    assert.equal(ride.rideStatus, "completed");
    assert.equal(ride.paymentStatus, "successful");
    const owed = await Transaction.find({ rideId: id, type: "commission" });
    assert.equal(owed.length, 1, "retries don't double-charge");
    assert.equal(owed[0].status, "pending");
    assert.equal(owed[0].amount, -ride.commissionAmount);
    assert.equal(await Wallet.countDocuments({ driverId: driver.user._id, balance: { $gt: 0 } }), 0, "no wallet money moved");
});

test("ride reports become support cases; platform status says which payments are live", async () => {
    const SupportCase = load("models/SupportCase.js");
    const passenger = await makePassenger();
    const driver = await makeDriver();
    const { body } = await requestRide(app, passenger);
    await post(`/api/rides/${body.data.rideId}/accept`, driver);
    assert.equal((await post(`/api/rides/${body.data.rideId}/report`, passenger, { description: "x" })).status, 400);
    const rep = await post(`/api/rides/${body.data.rideId}/report`, passenger, { issue: "Driver took a long route", description: "Went via Kimironko for no reason", category: "other" });
    assert.equal(rep.status, 201, rep.body.message);
    assert.equal(await SupportCase.countDocuments({ rideId: body.data.rideId }), 1);
    assert.equal((await post(`/api/rides/${body.data.rideId}/report`, await makePassenger(), { description: "not my ride" })).status, 404);
    const status = await request(app).get("/api/production/status");
    assert.equal(status.body.data.features.momoRidePayments, false, "guarded unless FINANCIAL_WRITES_ENABLED=true");
    assert.equal(status.body.data.features.cashRides, true);
});
