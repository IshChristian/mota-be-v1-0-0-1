// Live map data: the ride alert carries coordinates, the passenger's position reaches only
// the assigned driver (and only until pickup), and available drivers are visible moving.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makeDriver, makePassenger, requestRide, KIMIHURURA, REMERA } = require("./fixtures");

let app, sse, Ride;
before(async () => { app = await startStack(); sse = load("services/sseService.js"); Ride = load("models/Ride.js"); });
after(stopStack);
beforeEach(clearDb);

function captureEvents(t) {
    const events = [];
    t.mock.method(sse, "sendEventToUser", (userId, event, data) => { events.push({ userId: String(userId), event, data }); });
    return events;
}

test("ride alert includes pickup and destination coordinates for the driver's map", async (t) => {
    const events = captureEvents(t);
    const driver = await makeDriver();
    await requestRide(app, await makePassenger());
    for (let i = 0; i < 50 && !events.some((e) => e.event === "ride_request"); i++) await new Promise((r) => setTimeout(r, 20));
    const offer = events.find((e) => e.event === "ride_request" && e.userId === String(driver.user._id));
    assert.ok(offer, "driver got the ride request");
    assert.equal(offer.data.pickup.latitude, KIMIHURURA.latitude);
    assert.equal(offer.data.pickup.longitude, KIMIHURURA.longitude);
    assert.equal(offer.data.destination.latitude, REMERA.latitude);
    assert.equal(offer.data.destination.longitude, REMERA.longitude);
});

test("passenger location reaches the assigned driver before pickup, and stops once the trip starts", async (t) => {
    const driver = await makeDriver();
    const passenger = await makePassenger();
    const rideId = (await requestRide(app, passenger)).body.data.rideId;
    const accepted = await request(app).post(`/api/rides/${rideId}/accept`).set(driver.auth);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    const events = captureEvents(t);
    const res = await request(app).post("/api/realtime/location").set(passenger.auth).send({ latitude: -1.9541, longitude: 30.0931 });
    assert.equal(res.status, 200);
    assert.equal(res.body.shared, true);
    const sent = events.find((e) => e.event === "passengerLocation");
    assert.equal(sent.userId, String(driver.user._id));
    assert.equal(sent.data.latitude, -1.9541);

    const forDriver = await request(app).get(`/api/rides/${rideId}`).set(driver.auth);
    assert.equal(forDriver.body.data.ride.passengerLocation.latitude, -1.9541);

    await Ride.updateOne({ _id: rideId }, { $set: { rideStatus: "in_progress" } });
    const after = await request(app).post("/api/realtime/location").set(passenger.auth).send({ latitude: -1.955, longitude: 30.1 });
    assert.equal(after.body.shared, false);
    assert.equal(events.filter((e) => e.event === "passengerLocation").length, 1);
    const later = await request(app).get(`/api/rides/${rideId}`).set(driver.auth);
    assert.equal(later.body.data.ride.passengerLocation, undefined);
});

test("a passenger with no assigned driver shares nothing", async (t) => {
    const events = captureEvents(t);
    const passenger = await makePassenger();
    const res = await request(app).post("/api/realtime/location").set(passenger.auth).send({ latitude: -1.95, longitude: 30.09 });
    assert.equal(res.body.shared, false);
    assert.equal(events.length, 0);
});

test("nearby drivers are anonymous but precise enough to watch them move", async () => {
    const driver = await makeDriver();
    const passenger = await makePassenger();
    const res = await request(app).get("/api/realtime/nearby-drivers").set(passenger.auth).query({ lat: KIMIHURURA.latitude, lng: KIMIHURURA.longitude, radius: 3 });
    assert.equal(res.status, 200);
    const [d] = res.body.data;
    assert.equal(d.latitude, Math.round(driver.user.lastLocation.latitude * 10000) / 10000);
    assert.equal(d.firstName, undefined);
    assert.equal(d.phone, undefined);
});
