// Unit tests for the Google → OpenStreetMap routing fallback (axios stubbed; no network).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const axios = require("axios"); // same CommonJS instance routingService uses
const routing = require("../services/routingService");

const A = { latitude: -1.9536, longitude: 30.0927 }, B = { latitude: -1.9577, longitude: 30.1127 };
const osrmBody = { code: "Ok", routes: [{ distance: 3326, duration: 360, geometry: "abc", legs: [{ steps: [
    { name: "KN 5 Rd", distance: 327, maneuver: { type: "depart", modifier: "right" } },
    { name: "KN 5 Road", distance: 13, maneuver: { type: "roundabout", modifier: "right", exit: 1 } },
    { name: "", distance: 0, maneuver: { type: "arrive" } },
] }] }] };

beforeEach(() => { routing._clearCache(); process.env.OSRM_URL = "https://osrm.test"; });

test("Google failure falls back to OpenStreetMap", async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = "k";
    t.mock.method(axios, "post", async () => { throw Object.assign(new Error("quota"), { response: { status: 429 } }); });
    t.mock.method(axios, "get", async () => ({ data: osrmBody }));
    const route = await routing.getRoute(A, B);
    assert.equal(route.source, "osm");
    assert.equal(route.distanceMeters, 3326);
    assert.deepEqual(route.steps.map((s) => s.instruction), ["Start on KN 5 Rd", "At the roundabout, take exit 1 onto KN 5 Road", "Arrive at your destination"]);
});

test("Google 'no route' also falls back; Google success is used first", async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = "k";
    const post = t.mock.method(axios, "post", async () => ({ data: { routes: [] } }));
    t.mock.method(axios, "get", async () => ({ data: osrmBody }));
    assert.equal((await routing.getRoute(A, B)).source, "osm");
    routing._clearCache();
    post.mock.mockImplementation(async () => ({ data: { routes: [{ distanceMeters: 3100, duration: "420s", polyline: { encodedPolyline: "g" }, legs: [{ steps: [{ distanceMeters: 100, navigationInstruction: { instructions: "Head north", maneuver: "DEPART" } }] }] }] } }));
    const route = await routing.getRoute(A, B);
    assert.equal(route.source, "google");
    assert.equal(route.durationSeconds, 420);
});

test("no providers → null (callers use straight-line estimates)", async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = "";
    process.env.OSRM_URL = "";
    assert.equal(await routing.getRoute(A, B), null);
});
