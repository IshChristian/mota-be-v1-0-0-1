const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const request = require("supertest");

// A mail server that never answers: ride requests must not wait for it.
const sockets = new Set();
const silent = net.createServer((s) => { sockets.add(s); s.on("error", () => {}); });
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makePassenger, makeDriver, requestRide, wait, KIMIHURURA } = require("./fixtures");

let app, Ride, User, engine;
before(async () => {
    await new Promise((r) => silent.listen(0, "127.0.0.1", r));
    Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(silent.address().port), SMTP_USER: "u", SMTP_PASS: "p" });
    delete process.env.BREVO_API_KEY;
    app = await startStack();
    Ride = load("models/Ride.js"); User = load("models/User.js"); engine = load("services/rideEngineService.js");
});
after(async () => { for (const s of sockets) s.destroy(); silent.close(); await stopStack(); });
beforeEach(clearDb);

const post = (path, who, body = {}) => request(app).post(path).set(who.auth).send(body);
const ACTIVE = ["accepted", "approaching", "arrived", "start_requested", "in_progress"];
const searching = (driver, passenger) => Ride.create({
    passengerId: passenger.user._id, pickup: KIMIHURURA, destination: KIMIHURURA, fare: 1000, offeredFare: 1000, maximumFare: 3000, estimatedDistanceKm: 2,
    paymentMethod: "cash", vehicleType: "motor", rideStatus: "searching", notifiedDrivers: [].concat(driver).map((d) => d.user._id), requestedAt: new Date(), lastDispatchAt: new Date(), ridePin: "1234",
});

test("a dead mail server does not hold up requesting or accepting a ride", async () => {
    const drivers = [await makeDriver(), await makeDriver(), await makeDriver()];
    for (const d of drivers) await User.updateOne({ _id: d.user._id }, { email: `${d.user._id}@example.com` });
    const p = await makePassenger({ email: "p@example.com" });
    let start = Date.now();
    const res = await requestRide(app, p);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(Date.now() - start < 4000, `request took ${Date.now() - start} ms`);
    start = Date.now();
    const ok = await post(`/api/rides/${res.body.data.rideId}/accept`, drivers[0]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Date.now() - start < 4000, `accept took ${Date.now() - start} ms`);
});

test("one driver accepting many rides at once gets exactly one", async () => {
    const driver = await makeDriver();
    const rides = [];
    for (let i = 0; i < 8; i++) rides.push(await searching(driver, await makePassenger()));
    const results = await Promise.all(rides.map((r) => post(`/api/rides/${r._id}/accept`, driver)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(await Ride.countDocuments({ driverId: driver.user._id, rideStatus: { $in: ACTIVE } }), 1);
});

test("many drivers accepting one ride: exactly one wins", async () => {
    const drivers = [];
    for (let i = 0; i < 8; i++) drivers.push(await makeDriver());
    const ride = await searching(drivers, await makePassenger());
    const results = await Promise.all(drivers.map((d) => post(`/api/rides/${ride._id}/accept`, d)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test("support and a driver's own accept cannot give one driver two rides", async () => {
    const driver = await makeDriver();
    const admin = await makePassenger({ role: "superadmin" });
    const [a, b] = [await searching(driver, await makePassenger()), await searching(driver, await makePassenger())];
    await Promise.all([post(`/api/rides/${a._id}/accept`, driver), post(`/api/admin/support-rides/${b._id}/assign-driver`, admin, { driverId: driver.user._id })]);
    assert.equal(await Ride.countDocuments({ driverId: driver.user._id, rideStatus: { $in: ACTIVE } }), 1);
});

test("a passenger tapping Request several times gets one ride", async () => {
    await makeDriver();
    const p = await makePassenger();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => requestRide(app, p)));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(await Ride.countDocuments({ passengerId: p.user._id }), 1);
});

test("20 passengers at once are all answered, and offers are spread over the drivers", async () => {
    const drivers = [];
    for (let i = 0; i < 6; i++) drivers.push(await makeDriver());
    const passengers = [];
    for (let i = 0; i < 20; i++) passengers.push(await makePassenger());
    const start = Date.now();
    const results = await Promise.all(passengers.map((p) => requestRide(app, p, { backupDrivers: 1 })));
    assert.equal(results.filter((r) => r.status === 201).length, 20, JSON.stringify(results.find((r) => r.status !== 201)?.body));
    assert.ok(Date.now() - start < 15000, `${Date.now() - start} ms`);
    // One at a time, the next request goes to a driver with fewer open offers.
    await Ride.deleteMany({});
    for (const p of passengers.slice(0, 6)) await requestRide(app, p, { backupDrivers: 1 });
    const offered = new Set((await Ride.find({})).flatMap((r) => r.notifiedDrivers.map(String)));
    assert.equal(offered.size, 6);
});

test("accepting one ride hands the driver's other offers on straight away", async () => {
    const [first, second] = [await makeDriver(), await makeDriver()];
    const [a, b] = [await searching(first, await makePassenger()), await searching(first, await makePassenger())];
    assert.equal((await post(`/api/rides/${a._id}/accept`, first)).status, 200);
    for (let i = 0; i < 40 && !(await Ride.findById(b._id)).notifiedDrivers.some((d) => String(d) === String(second.user._id)); i++) await wait(100);
    assert.deepEqual((await Ride.findById(b._id)).notifiedDrivers.map(String), [String(second.user._id)]);
    const list = await request(app).get("/api/rides/driver/requests").set(first.auth);
    assert.deepEqual(list.body.data, []);
});

test("the driver's request list carries what the alert shows", async () => {
    const driver = await makeDriver();
    const ride = await searching(driver, await makePassenger());
    const list = await request(app).get("/api/rides/driver/requests").set(driver.auth);
    const [item] = list.body.data;
    assert.equal(String(item._id), String(ride._id));
    assert.equal(item.paymentMethod, "cash");
    assert.equal(item.maximumFare, 3000);
    assert.equal(typeof item.pickup.distanceKm, "number");
    assert.equal(typeof item.driverEarning, "number");
});

test("overlapping background jobs dispatch a stale ride once", async () => {
    const ride = await searching([], await makePassenger());
    await Ride.updateOne({ _id: ride._id }, { lastDispatchAt: new Date(Date.now() - 120000) });
    await Promise.all([engine.expireStaleRequests(), engine.expireStaleRequests(), engine.expireStaleRequests()]);
    assert.equal((await Ride.findById(ride._id)).dispatchRound, 1);
});
