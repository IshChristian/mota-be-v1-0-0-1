// Place search: Google and OpenStreetMap together, merged without duplicates (axios stubbed; no network).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios"); // same CommonJS instance geocodeService uses

let geocode;
beforeEach(() => {
    delete require.cache[require.resolve("../services/geocodeService")]; // fresh cache per test
    geocode = require("../services/geocodeService");
});

const google = (places) => async () => ({ data: { places: places.map(([name, latitude, longitude, address = "Kigali, Rwanda"]) => ({ displayName: { text: name }, formattedAddress: address, location: { latitude, longitude } })) } });
const osm = (rows) => async () => ({ data: rows.map(([name, lat, lon]) => ({ display_name: `${name}, Kigali, Rwanda`, lat: String(lat), lon: String(lon) })) });

test("results from both providers are merged, Google first, duplicates removed", async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = "k";
    t.mock.method(axios, "post", google([["Kigali Heights", -1.9535, 30.0934], ["Kigali Convention Centre", -1.9541, 30.0935]]));
    t.mock.method(axios, "get", osm([
        ["Kigali Heights", -1.95352, 30.09345],          // same place, a few metres off → duplicate
        ["Kigali Convention Center", -1.9541, 30.0935],  // other spelling, same spot → duplicate
        ["Kigali Heights Car Park", -1.9600, 30.1000],   // contains the name but ~900 m away → different place
        ["Kimironko Market", -1.9497, 30.1260],          // only OpenStreetMap has it
    ]));
    const results = await geocode.searchPlaces("Kigali", { latitude: -1.95, longitude: 30.09 });
    assert.deepEqual(results.map((r) => `${r.source}:${r.name}`), [
        "google:Kigali Heights",
        "google:Kigali Convention Centre",
        "osm:Kigali Heights Car Park",
        "osm:Kimironko Market",
    ]);
});

test("merge rules: same name far apart stays; accents and punctuation don't create duplicates", () => {
    const at = (name, latitude, longitude, source) => ({ name, latitude, longitude, source });
    const merged = geocode.mergePlaces(
        [at("Café Néo", -1.95, 30.06, "google"), at("Simba Supermarket", -1.944, 30.06, "google")],
        [at("cafe neo", -1.9501, 30.0601, "osm"), at("Simba Supermarket", -1.98, 30.12, "osm"), at("Bad", NaN, 30, "osm")],
    );
    assert.deepEqual(merged.map((r) => `${r.source}:${r.name}`), ["google:Café Néo", "google:Simba Supermarket", "osm:Simba Supermarket"]);
});

test("Google failing still returns OpenStreetMap places; OpenStreetMap failing still returns Google", async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = "k";
    const post = t.mock.method(axios, "post", async () => { throw Object.assign(new Error("denied"), { response: { data: { error: { message: "Places API (New) has not been used in project" } } } }); });
    const get = t.mock.method(axios, "get", osm([["Nyabugogo Bus Park", -1.939, 30.044]]));
    t.mock.method(console, "warn", () => {});
    assert.deepEqual((await geocode.searchPlaces("Nyabugogo")).map((r) => r.source), ["osm"]);
    post.mock.mockImplementation(google([["Nyamirambo Stadium", -1.98, 30.04]]));
    get.mock.mockImplementation(async () => { throw new Error("rate limited"); });
    assert.deepEqual((await geocode.searchPlaces("Nyamirambo")).map((r) => r.source), ["google"]);
});

test("without a Google key, OpenStreetMap alone is used and its failure is reported", async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = "";
    const post = t.mock.method(axios, "post", async () => { throw new Error("should not be called"); });
    const get = t.mock.method(axios, "get", osm([["Remera Taxi Park", -1.958, 30.113]]));
    assert.equal((await geocode.searchPlaces("Remera")).length, 1);
    assert.equal(post.mock.callCount(), 0);
    get.mock.mockImplementation(async () => { throw new Error("down"); });
    t.mock.method(console, "warn", () => {});
    await assert.rejects(geocode.searchPlaces("Gisozi"));
});
