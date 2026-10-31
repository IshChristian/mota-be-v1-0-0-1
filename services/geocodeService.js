// Place search for the app. Phones never call OpenStreetMap directly: its public
// Nominatim server allows ~1 request/second for the whole app, so requests are
// cached and queued here. With GOOGLE_MAPS_API_KEY, Google Places is used first.
const axios = require("axios");

const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 5000;
let lastCall = 0;
let queue = Promise.resolve();

const nominatimUrl = () => (process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
const userAgent = () => process.env.NOMINATIM_USER_AGENT || "MOTA-Backend/1.0 (support@mota.africa)";

function cached(key) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    cache.delete(key);
    return undefined;
}
function remember(key, value) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
}

function nominatim(path) {
    const run = async () => {
        const wait = Math.max(0, lastCall + 1100 - Date.now());
        if (wait) await new Promise((r) => setTimeout(r, wait));
        lastCall = Date.now();
        const res = await axios.get(`${nominatimUrl()}${path}`, { headers: { "User-Agent": userAgent(), "Accept-Language": "en" }, timeout: 8000 });
        return res.data;
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
}

const shortName = (displayName) => String(displayName || "").split(",")[0].trim();

async function googleSearch(q, near) {
    const res = await axios.post("https://places.googleapis.com/v1/places:searchText", {
        textQuery: q,
        regionCode: "RW",
        maxResultCount: 10,
        ...(near ? { locationBias: { circle: { center: near, radius: 20000 } } } : {}),
    }, {
        headers: { "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location" },
        timeout: 8000,
    });
    return (res.data.places || []).map((p) => ({ name: p.displayName?.text || shortName(p.formattedAddress), address: p.formattedAddress || "", latitude: p.location.latitude, longitude: p.location.longitude }));
}

async function searchPlaces(query, near) {
    const q = String(query || "").trim().slice(0, 120);
    if (q.length < 3) return [];
    const key = `s:${q.toLowerCase()}`;
    const hit = cached(key);
    if (hit) return hit;
    // Google first; OpenStreetMap when Google errors OR finds nothing (and vice versa without a key).
    let results = [];
    if (process.env.GOOGLE_MAPS_API_KEY) {
        try { results = await googleSearch(q, near); }
        catch (error) { console.warn("Google Places search failed, using OpenStreetMap:", error.message); }
    }
    if (!results.length) {
        try {
            const rows = await nominatim(`/search?q=${encodeURIComponent(q)}&format=json&countrycodes=rw&limit=10`);
            results = rows.map((r) => ({ name: shortName(r.display_name), address: String(r.display_name || "").split(",").slice(1).join(",").trim(), latitude: Number(r.lat), longitude: Number(r.lon) }));
        } catch (error) {
            if (!process.env.GOOGLE_MAPS_API_KEY) throw error;
            console.warn("OpenStreetMap search failed:", error.message);
        }
    }
    return results.length ? remember(key, results) : results;
}

async function reverseGeocode({ latitude, longitude }) {
    const key = `r:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const hit = cached(key);
    if (hit) return hit;
    const row = await nominatim(`/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=18`);
    return remember(key, { name: shortName(row?.display_name) || "Selected location", address: row?.display_name || "", latitude, longitude });
}

module.exports = { searchPlaces, reverseGeocode };
