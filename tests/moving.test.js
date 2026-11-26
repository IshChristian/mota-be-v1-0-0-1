// MOTA Kwimuka (house moving): booking, estimates, customer actions and the staff workflow.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack } = require("./harness");
const { load, makePassenger } = require("./fixtures");

let app, User, MoveRequest, Notification, moving;
before(async () => {
    app = await startStack();
    User = load("models/User.js");
    MoveRequest = load("models/MoveRequest.js");
    Notification = load("models/Notification.js");
    moving = load("services/movingService.js");
});
after(stopStack);

const { generateToken } = load("utils/jwt.js");
const bearer = (user) => ({ Authorization: `Bearer ${generateToken(user)}` });
let seq = 0;
const staff = (role, extra = {}) => User.create({ firstName: "Staff", lastName: role, phone: `+25079${String(5000000 + ++seq).slice(-7)}`, role, isActive: true, isVerified: true, ...extra });
const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString();

const KIMIHURURA = { name: "Kimihurura", address: "KG 7 Ave", latitude: -1.9536, longitude: 30.0927, placeType: "apartment", floor: 2, hasElevator: false, truckAccess: "at_door", landmark: "Near the blue gate" };
const REMERA = { name: "Remera", latitude: -1.9577, longitude: 30.1127, placeType: "house", floor: 0, truckAccess: "short_walk" };
const MUSANZE = { name: "Musanze", latitude: -1.4998, longitude: 29.6349, placeType: "house", floor: 0, truckAccess: "at_door" };
const booking = (extra = {}) => ({ from: KIMIHURURA, to: REMERA, homeSize: "two_bedroom", items: [{ key: "bed", qty: 2 }, { key: "sofa", qty: 1 }], truckKey: "medium", loaders: 3, moveDate: tomorrow(), contactPhone: "+250788123456", ...extra });

test("catalog lists four trucks with price ranges, smallest first", async () => {
    const res = await request(app).get("/api/moves/catalog").expect(200);
    const keys = res.body.data.trucks.map((t) => t.key);
    assert.deepEqual(keys, ["pickup", "small", "medium", "large"]);
    for (const t of res.body.data.trucks) assert.ok(t.priceMin > 0 && t.priceMax >= t.priceMin && t.photoCredit);
    assert.ok(res.body.data.itemKeys.includes("fridge"));
});

test("recommendation follows home size and bumps up for many items", async () => {
    const trucks = moving.DEFAULT_TRUCKS;
    assert.equal(moving.recommendKey(trucks, "few_items"), "pickup");
    assert.equal(moving.recommendKey(trucks, "one_bedroom"), "small");
    assert.equal(moving.recommendKey(trucks, "three_bedroom"), "medium");
    assert.equal(moving.recommendKey(trucks, "office"), "large");
    assert.equal(moving.recommendKey(trucks, "one_bedroom", [{ key: "boxes", qty: 45 }]), "medium");
});

test("estimate adds loaders and stairs inside Kigali; distance outside", async () => {
    const { user } = await makePassenger();
    const res = await request(app).post("/api/moves/estimate").set(bearer(user)).send(booking()).expect(200);
    const e = res.body.data;
    // medium 100k–170k + 3 loaders (21k) + 2 floors without lift (4k)
    assert.equal(e.min, 125000);
    assert.equal(e.max, 195000);
    assert.equal(e.breakdown.distance, 0);
    const far = (await request(app).post("/api/moves/estimate").set(bearer(user)).send(booking({ to: MUSANZE })).expect(200)).body.data;
    assert.ok(far.distanceKm > 80, `distance ${far.distanceKm}`);
    assert.ok(far.min > e.min + 50000);
});

test("booking needs full location details and a truck or a visit", async () => {
    const { user } = await makePassenger();
    const post = (body) => request(app).post("/api/moves").set(bearer(user)).send(body);
    assert.match((await post(booking({ from: { ...KIMIHURURA, truckAccess: undefined } })).expect(400)).body.message, /truck can park/);
    assert.match((await post(booking({ to: { name: "Remera" } })).expect(400)).body.message, /destination location/);
    assert.match((await post(booking({ truckKey: undefined })).expect(400)).body.message, /home visit/);
    assert.match((await post(booking({ moveDate: "2020-01-01" })).expect(400)).body.message, /past/);
    assert.match((await post(booking({ contactPhone: "abc" })).expect(400)).body.message, /phone/);
});

test("customer books, staff is alerted, customer sees it", async () => {
    const { user } = await makePassenger();
    const support = await staff("caller_support");
    const res = await request(app).post("/api/moves").set(bearer(user)).send(booking({ source: "app", campaign: "fb-nov" })).expect(201);
    const move = res.body.data;
    assert.match(move.ref, /^KW-[0-9A-F]{6}$/);
    assert.equal(move.status, "requested");
    assert.equal(move.estimate.min, 125000);
    assert.equal(move.campaign, "fb-nov");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await Notification.exists({ userId: support._id, "metadata.moveId": move._id }));
    assert.ok(await Notification.exists({ userId: user._id, "metadata.moveId": move._id }));
    const mine = (await request(app).get("/api/moves").set(bearer(user)).expect(200)).body.data;
    assert.equal(mine[0]._id, move._id);
    const { user: other } = await makePassenger();
    await request(app).get(`/api/moves/${move._id}`).set(bearer(other)).expect(404);
});

test("home visit request needs a visit date instead of a moving date", async () => {
    const { user } = await makePassenger();
    const body = booking({ truckKey: undefined, moveDate: undefined, wantsVisit: true });
    assert.match((await request(app).post("/api/moves").set(bearer(user)).send(body).expect(400)).body.message, /home visit date/);
    const move = (await request(app).post("/api/moves").set(bearer(user)).send({ ...body, visit: { preferredDate: tomorrow(), timeWindow: "afternoon" } }).expect(201)).body.data;
    assert.equal(move.wantsVisit, true);
    assert.equal(move.truckKey, null);
    assert.equal(move.visit.timeWindow, "afternoon");
});

test("full staff workflow: visit → quote → accept → confirm → complete", async () => {
    const { user } = await makePassenger();
    const ops = await staff("caller_support");
    const move = (await request(app).post("/api/moves").set(bearer(user)).send(booking({ truckKey: undefined, moveDate: undefined, wantsVisit: true, visit: { preferredDate: tomorrow() } })).expect(201)).body.data;
    const patch = (body) => request(app).patch(`/api/admin/moves/${move._id}`).set(bearer(ops)).send(body);

    assert.match((await patch({ status: "visit_scheduled" }).expect(400)).body.message, /visit date/);
    await patch({ status: "visit_scheduled", visitScheduledAt: tomorrow() }).expect(200);
    await patch({ status: "visited" }).expect(200);
    assert.match((await patch({ status: "quoted" }).expect(400)).body.message, /price/);
    await patch({ status: "quoted", quoteAmount: 140000, quoteNote: "Medium truck, 3 loaders" }).expect(200);
    assert.match((await patch({ status: "completed" }).expect(409)).body.message, /can't go/);

    await request(app).post(`/api/moves/${move._id}/accept`).set(bearer(user)).expect(200);
    await request(app).post(`/api/moves/${move._id}/accept`).set(bearer(user)).expect(409);
    assert.match((await patch({ status: "confirmed", partner: { phone: "+250788000111", plate: "rad 123 a" } }).expect(400)).body.message, /moving date/);
    const confirmed = (await patch({ status: "confirmed", moveDate: tomorrow(), partner: { company: "Kigali Movers", driverName: "Eric", phone: "+250788000111", plate: "rad 123 a" } }).expect(200)).body.data;
    assert.equal(confirmed.partner.plate, "RAD 123 A");
    await patch({ status: "in_progress" }).expect(200);
    await request(app).post(`/api/moves/${move._id}/cancel`).set(bearer(user)).expect(409);
    const done = (await patch({ status: "completed" }).expect(200)).body.data;
    assert.deepEqual(done.statusHistory.map((h) => h.status), ["requested", "visit_scheduled", "visited", "quoted", "accepted", "confirmed", "in_progress", "completed"]);
    const seen = (await request(app).get(`/api/moves/${move._id}`).set(bearer(user)).expect(200)).body.data;
    assert.equal(seen.staffNotes, undefined);
});

test("customer can cancel before the move starts; at most 3 active moves", async () => {
    const { user } = await makePassenger();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await request(app).post("/api/moves").set(bearer(user)).send(booking()).expect(201)).body.data._id);
    assert.match((await request(app).post("/api/moves").set(bearer(user)).send(booking()).expect(400)).body.message, /3 moves/);
    const cancelled = (await request(app).post(`/api/moves/${ids[0]}/cancel`).set(bearer(user)).send({ reason: "Changed plans" }).expect(200)).body.data;
    assert.equal(cancelled.status, "cancelled");
    await request(app).post("/api/moves").set(bearer(user)).send(booking()).expect(201);
});

test("staff permissions: passengers and agents can't manage moves; trucks are editable", async () => {
    const { user } = await makePassenger();
    await request(app).get("/api/admin/moves").set(bearer(user)).expect(403);
    const agent = await staff("agent");
    await request(app).get("/api/admin/moves").set(bearer(agent)).expect(403);
    const admin = await staff("admin");
    const list = (await request(app).get("/api/admin/moves?status=active").set(bearer(admin)).expect(200)).body.data;
    assert.ok(list.total >= 1 && list.counts.requested >= 1);
    assert.match((await request(app).patch("/api/admin/moves/trucks/small").set(bearer(admin)).send({ priceMin: 99999999 }).expect(400)).body.message, /lowest price/);
    const t = (await request(app).patch("/api/admin/moves/trucks/small").set(bearer(admin)).send({ priceMin: 55000, imageUrl: "https://cdn.test/truck.jpg" }).expect(200)).body.data;
    assert.equal(t.priceMin, 55000);
    const cat = (await request(app).get("/api/moves/catalog").expect(200)).body.data;
    assert.equal(cat.trucks.find((x) => x.key === "small").imageUrl, "https://cdn.test/truck.jpg");
    await request(app).patch("/api/admin/moves/trucks/small").set(bearer(admin)).send({ priceMin: 50000, imageUrl: "" }).expect(200);
});
