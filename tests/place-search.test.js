// Place search: free sources first (MOTA places, Photon, Nominatim fallback), Google only
// when explicitly enabled. axios is stubbed, so no network is used.
const { test, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios"); // same CommonJS instance geocodeService uses

let geocode;
beforeEach(() => {
    delete require.cache[require.resolve("../services/geocodeService")]; // fresh cache per test
    geocode = require("../services/geocodeService");
    process.env.PLACES_GOOGLE_ENABLED = "";
    process.env.GOOGLE_MAPS_API_KEY = "";
});

/** Photon GeoJSON features: [name, lat, lng, countrycode?, extra properties?] */
const photon = (rows) => ({ data: { features: rows.map(([name, lat, lng, countrycode = "RW", extra = {}]) => ({ geometry: { coordinates: [lng, lat] }, properties: { name, countrycode, district: "Gasabo", city: "Kigali", ...extra } })) } });
const nominatim = (rows) => ({ data: rows.map(([name, lat, lon]) => ({ display_name: `${name}, Kigali, Rwanda`, lat: String(lat), lon: String(lon) })) });
const google = (places) => async () => ({ data: { places: places.map(([name, latitude, longitude]) => ({ displayName: { text: name }, formattedAddress: "Kigali, Rwanda", location: { latitude, longitude } })) } });
/** Routes axios.get by host: photon.komoot.io vs nominatim. */
function stubGet(t, { photonRows, photonError, nominatimRows = [] }) {
    const calls = { photon: 0, nominatim: 0 };
    t.mock.method(axios, "get", async (url) => {
        if (url.includes("photon")) { calls.photon++; if (photonError) throw new Error(photonError); return photon(photonRows || []); }
        calls.nominatim++; return nominatim(nominatimRows);
    });
    return calls;
}

test("Photon is the main free source: partial words match, results stay in Rwanda, address is readable", async (t) => {
    const calls = stubGet(t, { photonRows: [
        ["Kimihurura", -1.9536, 30.0927, "RW", { district: "Gasabo", city: "Kigali" }],
        ["Rubavu", -1.68, 29.25, "CD"],                 // across the border in Congo → dropped
        ["Somewhere far", 0.31, 32.58, "RW"],           // wrong coordinates outside Rwanda → dropped
    ] });
    const results = await geocode.searchPlaces("Kimihur", { latitude: -1.95, longitude: 30.06 });
    assert.deepEqual(results.map((r) => r.name), ["Kimihurura"]);
    assert.equal(results[0].address, "Gasabo, Kigali");
    assert.equal(calls.nominatim, 0, "Nominatim isn't called when Photon answers");
});

test("Nominatim is only a fallback when Photon fails or finds nothing", async (t) => {
    const calls = stubGet(t, { photonError: "down", nominatimRows: [["Nyabugogo Bus Park", -1.939, 30.044]] });
    t.mock.method(console, "warn", () => {});
    assert.deepEqual((await geocode.searchPlaces("Nyabugogo")).map((r) => r.name), ["Nyabugogo Bus Park"]);
    assert.equal(calls.nominatim, 1);
    const empty = stubGet(t, { photonRows: [], nominatimRows: [["Gisozi Memorial", -1.931, 30.06]] });
    assert.deepEqual((await geocode.searchPlaces("Gisozi Memo")).map((r) => r.name), ["Gisozi Memorial"]);
    assert.equal(empty.nominatim, 1);
});

test("all sources down is reported, not shown as 'no places'", async (t) => {
    t.mock.method(axios, "get", async () => { throw new Error("offline"); });
    t.mock.method(console, "warn", () => {});
    await assert.rejects(geocode.searchPlaces("Remera"));
});

test("Google (paid) is never called unless PLACES_GOOGLE_ENABLED=true", async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = "key-present";
    stubGet(t, { photonRows: [["Kigali Heights", -1.9535, 30.0934]] });
    const post = t.mock.method(axios, "post", google([["Kigali Heights", -1.9535, 30.0934]]));
    await geocode.searchPlaces("Kigali Heights");
    assert.equal(post.mock.callCount(), 0, "a Google key alone doesn't spend money");
    process.env.PLACES_GOOGLE_ENABLED = "true";
    post.mock.mockImplementation(google([["Kigali Heights", -1.95352, 30.09345], ["Kigali Arena", -1.95, 30.11]]));
    const results = await geocode.searchPlaces("Kigali H");
    assert.equal(post.mock.callCount(), 1);
    assert.deepEqual(results.map((r) => `${r.source}:${r.name}`), ["google:Kigali Heights", "google:Kigali Arena"], "duplicate from Photon removed");
});

test("one neighbourhood listed twice (point and outline) shows once, labelled by kind", async (t) => {
    stubGet(t, { photonRows: [
        ["Kimihurura", -1.9565, 30.0914, "RW", { osm_key: "place", osm_value: "city", type: "city", district: undefined, city: undefined }],
        ["Kimihurura", -1.9528, 30.0817, "RW", { osm_key: "place", osm_value: "neighbourhood", type: "locality", district: undefined, city: "Kimihurura" }],
        ["Kimihurura Sector Office", -1.9566, 30.0976, "RW", { street: "KG 644 Street" }],
    ] });
    const results = await geocode.searchPlaces("Kimihurura");
    assert.deepEqual(results.map((r) => r.name), ["Kimihurura", "Kimihurura Sector Office"]);
    assert.equal(results[0].address, "Town · Rwanda");
    assert.equal(results[0].area, undefined, "internal flag not returned");
});

test("after Photon says it's busy, searches go to the fallback for a while instead of hammering it", async (t) => {
    t.mock.method(console, "warn", () => {});
    let photonCalls = 0;
    t.mock.method(axios, "get", async (url) => {
        if (url.includes("photon")) { photonCalls++; throw Object.assign(new Error("busy"), { response: { status: 503 } }); }
        return nominatim([["Remera Taxi Park", -1.958, 30.113]]);
    });
    assert.equal((await geocode.searchPlaces("Remera taxi")).length, 1);
    assert.equal((await geocode.searchPlaces("Remera park")).length, 1);
    assert.equal(photonCalls, 1, "second search skipped Photon");
});

test("merge rules: same name far apart stays; accents and punctuation don't create duplicates", () => {
    const at = (name, latitude, longitude, source) => ({ name, latitude, longitude, source });
    const merged = geocode.mergePlaces(
        [at("Café Néo", -1.95, 30.06, "mota"), at("Simba Supermarket", -1.944, 30.06, "mota")],
        [at("cafe neo", -1.9501, 30.0601, "osm"), at("Simba Supermarket", -1.98, 30.12, "osm"), at("Bad", NaN, 30, "osm")],
    );
    assert.deepEqual(merged.map((r) => `${r.source}:${r.name}`), ["mota:Café Néo", "mota:Simba Supermarket", "osm:Simba Supermarket"]);
});

test("reverse geocoding uses Photon first and falls back to Nominatim", async (t) => {
    const get = t.mock.method(axios, "get", async (url) => url.includes("photon") ? photon([["KG 7 Ave", -1.95, 30.09, "RW", { street: "KG 7 Ave", district: "Kacyiru" }]]) : { data: { display_name: "Kacyiru, Gasabo, Kigali" } });
    const place = await geocode.reverseGeocode({ latitude: -1.95, longitude: 30.09 });
    assert.equal(place.name, "KG 7 Ave");
    assert.equal(place.address, "Kacyiru, Kigali");
    get.mock.mockImplementation(async (url) => { if (url.includes("photon")) throw new Error("down"); return { data: { display_name: "Kacyiru, Gasabo, Kigali" } }; });
    assert.equal((await geocode.reverseGeocode({ latitude: -1.96, longitude: 30.08 })).name, "Kacyiru");
});

// ─── MOTA places (needs the database) ────────────────────────────────────────
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makePassenger } = require("./fixtures");
let Ride;
before(async () => { await startStack(); Ride = load("models/Ride.js"); });
after(stopStack);

async function rides(name, lat, lng, passengers) {
    for (const p of passengers) {
        await Ride.create({ passengerId: p.user._id, pickup: { name: "Remera", latitude: -1.958, longitude: 30.113 }, destination: { name, latitude: lat, longitude: lng }, fare: 1500, offeredFare: 1500, vehicleType: "motor", rideType: "ride", rideStatus: "completed", paymentMethod: "cash" });
    }
}

test("popular MOTA destinations come first; a place needs 3 different passengers; generic names never show", async (t) => {
    await clearDb();
    const people = [await makePassenger(), await makePassenger(), await makePassenger()];
    await rides("Kimironko Market Gate 2", -1.9497, 30.126, people);           // 3 passengers → shown
    await rides("Mama Aline's House", -1.96, 30.1, [people[0], people[0], people[0]]); // 1 passenger, 3 rides → private, hidden
    await rides("Current location", -1.95, 30.1, people);                        // generic → hidden
    await geocode.rebuildMotaPlaces();
    assert.deepEqual(geocode.motaMatches("kimi mark").map((p) => p.name), ["Kimironko Market Gate 2"]);
    assert.deepEqual(geocode.motaMatches("mama aline"), []);
    assert.deepEqual(geocode.motaMatches("current"), []);

    stubGet(t, { photonRows: [["Kimironko Market", -1.9496, 30.1259], ["Kimironko Bus Park", -1.951, 30.127]] });
    const results = await geocode.searchPlaces("Kimironko mar");
    assert.equal(results[0].source, "mota", "MOTA's own popular place is listed first");
    assert.ok(results.some((r) => r.name === "Kimironko Bus Park"));
});
