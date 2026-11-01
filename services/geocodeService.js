// Place search for the app. Phones never call OpenStreetMap directly: its public
// Nominatim server allows ~1 request/second for the whole app, so requests are
// cached and queued here. With GOOGLE_MAPS_API_KEY, Google Places and OpenStreetMap are
// searched together and merged (Google first, duplicates removed).
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
    return (res.data.places || []).map((p) => ({ name: p.displayName?.text || shortName(p.formattedAddress), address: p.formattedAddress || "", latitude: p.location.latitude, longitude: p.location.longitude, source: "google" }));
}

// Nominatim allows ~1 request/second for the whole app. When requests are already
// waiting, a search skips OpenStreetMap instead of making the user wait behind them.
let osmPending = 0;
async function osmSearch(q) {
    const key = `o:${q.toLowerCase()}`;
    const hit = cached(key);
    if (hit) return hit;
    if (osmPending >= 2) return [];
    osmPending++;
    try {
        const rows = await nominatim(`/search?q=${encodeURIComponent(q)}&format=json&countrycodes=rw&limit=10`);
        return remember(key, rows.map((r) => ({ name: shortName(r.display_name), address: String(r.display_name || "").split(",").slice(1).join(",").trim(), latitude: Number(r.lat), longitude: Number(r.lon), source: "osm" })));
    } finally { osmPending--; }
}

const normalize = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function metersBetween(a, b) {
    const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLng = (b.longitude - a.longitude) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
function wordOverlap(na, nb) {
    const a = new Set(na.split(" ")), b = new Set(nb.split(" "));
    const shared = [...a].filter((w) => b.has(w)).length;
    return shared / new Set([...a, ...b]).size;
}
/** Same place: same name close by, one name containing the other nearby, or mostly the same words at the same spot ("Centre"/"Center"). */
function samePlace(a, b) {
    const na = normalize(a.name), nb = normalize(b.name);
    if (!na || !nb) return false;
    const meters = metersBetween(a, b);
    if (na === nb) return meters < 500;
    if ((na.includes(nb) || nb.includes(na)) && meters < 150) return true;
    return meters < 100 && wordOverlap(na, nb) >= 0.5;
}
/** Google results first (better coverage in Rwanda), then OpenStreetMap places Google didn't have. */
function mergePlaces(primary, secondary, limit = 10) {
    const out = [];
    for (const place of [...primary, ...secondary]) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        if (out.some((kept) => samePlace(kept, place))) continue;
        out.push(place);
        if (out.length >= limit) break;
    }
    return out;
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

async function searchPlaces(query, near) {
    const q = String(query || "").trim().slice(0, 120);
    if (q.length < 3) return [];
    // Google ranks by distance from the user, so cache per ~10 km area.
    const area = near ? `${near.latitude.toFixed(1)},${near.longitude.toFixed(1)}` : "rw";
    const key = `s:${area}:${q.toLowerCase()}`;
    const hit = cached(key);
    if (hit) return hit;
    // Both providers at once; OpenStreetMap gets a short time budget so it never slows Google results down.
    const hasGoogle = Boolean(process.env.GOOGLE_MAPS_API_KEY);
    const [google, osm] = await Promise.all([
        hasGoogle ? googleSearch(q, near).catch((error) => { console.warn("Google Places search failed:", error.response?.data?.error?.message || error.message); return null; }) : null,
        (hasGoogle ? withTimeout(osmSearch(q), 2500) : osmSearch(q)).catch((error) => { console.warn("OpenStreetMap search failed:", error.message); return null; }),
    ]);
    if (google === null && osm === null && !hasGoogle) throw new Error("Place search is unavailable right now.");
    const results = mergePlaces(google || [], osm || []);
    // Cache only complete answers, so a slow OpenStreetMap reply can still be merged in next time.
    return results.length && (!hasGoogle || (google && osm)) ? remember(key, results) : results;
}

async function reverseGeocode({ latitude, longitude }) {
    const key = `r:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const hit = cached(key);
    if (hit) return hit;
    const row = await nominatim(`/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=18`);
    return remember(key, { name: shortName(row?.display_name) || "Selected location", address: row?.display_name || "", latitude, longitude });
}

module.exports = { searchPlaces, reverseGeocode, mergePlaces };
