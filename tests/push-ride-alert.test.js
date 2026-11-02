// What a driver's phone receives for a nearby ride request (Expo push service mocked).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makeDriver, makePassenger, requestRide } = require("./fixtures");

let app, User;
before(async () => { app = await startStack(); User = load("models/User.js"); });
after(stopStack);
beforeEach(clearDb);

function captureExpo(t) {
    const sent = [];
    const realFetch = global.fetch;
    t.mock.method(global, "fetch", async (url, options) => {
        if (String(url).startsWith("https://exp.host/")) {
            const messages = JSON.parse(options.body);
            sent.push(...messages);
            return { ok: true, json: async () => ({ data: messages.map(() => ({ status: "ok" })) }) };
        }
        return realFetch(url, options);
    });
    return sent;
}

test("nearby ride request rings on the ride_requests channel with MOTA's sound and expires in 2 minutes", async (t) => {
    const sent = captureExpo(t);
    const driver = await makeDriver();
    await User.updateOne({ _id: driver.user._id }, { $set: { pushTokens: [{ token: "ExponentPushToken[driver]", platform: "android" }] } });
    const passenger = await makePassenger();
    await requestRide(app, passenger);
    for (let i = 0; i < 50 && !sent.some((m) => m.data?.event === "rideRequest"); i++) await new Promise((r) => setTimeout(r, 20));
    const push = sent.find((m) => m.to === "ExponentPushToken[driver]" && m.data?.event === "rideRequest");
    assert.ok(push, `driver got no ride request push; sent: ${JSON.stringify(sent.map((m) => m.data?.event))}`);
    assert.equal(push.channelId, "ride_requests");
    assert.equal(push.sound, "mota_ride_request.wav");
    assert.equal(push.priority, "high");
    assert.equal(push.ttl, 120);
    assert.ok(push.data.rideId, "tapping the alert opens this ride");
});

test("other ride updates keep the normal ride channel and default sound, without the short expiry", async (t) => {
    const sent = captureExpo(t);
    const passenger = await makePassenger();
    await User.updateOne({ _id: passenger.user._id }, { $set: { pushTokens: [{ token: "ExponentPushToken[p]", platform: "ios" }] } });
    await load("services/notificationService.js").sendPushNotification(passenger.user._id, "Driver arrived", "Your driver is here", { event: "driverArrived" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, "rides");
    assert.equal(sent[0].sound, "default");
    assert.equal(sent[0].ttl, undefined);
});
