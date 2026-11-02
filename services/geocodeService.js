// Place search for the app, Rwanda only, free sources first:
//   1. MOTA places — destinations at least 3 different passengers completed rides to
//      (rebuilt every few hours from ride history; nobody's private address appears).
//   2. Photon (photon.komoot.io, OpenStreetMap data, free, made for search-as-you-type,
//      matches partly typed words: "Kimihur" → Kimihurura).
//   3. Nominatim (OpenStreetMap's own search) only when Photon fails or finds nothing;
//      its public server allows ~1 request/second, so calls are queued and cached here.
//   4. Google Places only when PLACES_GOOGLE_ENABLED=true (paid API, off by default).
// Phones never call these services directly. Results are cached for a day.
const axios = require("axios");

const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 5000;
let lastCall = 0;
let queue = Promise.resolve();

// Rwanda's bounding box (west, south, east, north); results outside it are dropped.
const RW_BBOX = [28.86, -2.84, 30.9, -1.04];
const KIGALI = { latitude: -1.9441, longitude: 30.0619 };
const inRwanda = (p) => p.longitude >= RW_BBOX[0] && p.longitude <= RW_BBOX[2] && p.latitude >= RW_BBOX[1] && p.latitude <= RW_BBOX[3];

const nominatimUrl = () => (process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
const photonUrl = () => (process.env.PHOTON_URL || "https://photon.komoot.io").replace(/\/+$/, "");
const userAgent = () => process.env.NOMINATIM_USER_AGENT || "MOTA-Backend/1.0 (support@mota.africa)";
const googleEnabled = () => process.env.PLACES_GOOGLE_ENABLED === "true" && Boolean(process.env.GOOGLE_MAPS_API_KEY);

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

const AREA_KIND = { neighbourhood: "Neighbourhood", suburb: "Suburb", quarter: "Neighbourhood", city: "Town", town: "Town", village: "Village", hamlet: "Village", city_block: "Neighbourhood", county: "District", state: "Province" };
const shortName = (displayName) => String(displayName || "").split(",")[0].trim();
const unique = (parts) => parts.filter((p, i) => p && parts.indexOf(p) === i);

// ─── Photon ──────────────────────────────────────────────────────────────────
/** "Kimironko Market" + "KG 11 Ave, Kimironko, Gasabo, Kigali" from Photon's properties. */
function fromPhoton(feature) {
    const p = feature.properties || {};
    const [longitude, latitude] = feature.geometry?.coordinates || [];
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.district || p.city;
    // Neighbourhoods, sectors, towns… have no street; label them by kind so the row isn't blank.
    const area = p.osm_key === "place" || ["city", "district", "locality", "county", "state"].includes(p.type);
    const parts = unique([p.street && p.name !== p.street ? p.street : null, p.locality, p.district, p.city, p.county, p.state].filter((x) => x && x !== name));
    const address = parts.length ? parts.join(", ") : area ? `${AREA_KIND[p.osm_value] || "Area"} · Rwanda` : "Rwanda";
    return { name, address, latitude: Number(latitude), longitude: Number(longitude), source: "osm", area, countrycode: p.countrycode };
}

// When the public Photon server says it's busy, give it a rest and use the fallback for a while.
let photonRestUntil = 0;
async function photonSearch(q, near) {
    if (Date.now() < photonRestUntil) throw new Error("Photon is resting after a busy reply");
    const center = near || KIGALI; // bias towards the user, or Kigali
    const res = await axios.get(`${photonUrl()}/api/`, {
        params: { q, limit: 15, lat: center.latitude, lon: center.longitude, bbox: RW_BBOX.join(","), lang: "en" },
        headers: { "User-Agent": userAgent() },
        timeout: 6000,
    }).catch((error) => {
        if ([429, 503].includes(error.response?.status)) photonRestUntil = Date.now() + 30000;
        throw error;
    });
    return (res.data?.features || []).map(fromPhoton).filter((p) => p.name && p.countrycode === "RW" && inRwanda(p)).map(({ countrycode, ...p }) => p);
}

/** Internal flags (like `area`) aren't part of the API response. */
const publicPlace = ({ area, ...place }) => place;

async function photonReverse({ latitude, longitude }) {
    const res = await axios.get(`${photonUrl()}/reverse`, { params: { lat: latitude, lon: longitude, limit: 1, lang: "en" }, headers: { "User-Agent": userAgent() }, timeout: 5000 });
    const feature = res.data?.features?.[0];
    if (!feature) return null;
    const place = fromPhoton(feature);
    return place.name ? { name: place.name, address: place.address, latitude, longitude } : null;
}

// ─── Nominatim (fallback) ────────────────────────────────────────────────────
let osmPending = 0;
async function nominatimSearch(q) {
    const key = `o:${q.toLowerCase()}`;
    const hit = cached(key);
    if (hit) return hit;
    if (osmPending >= 2) return []; // don't make users wait behind a queue
    osmPending++;
    try {
        const rows = await nominatim(`/search?q=${encodeURIComponent(q)}&format=json&countrycodes=rw&limit=10`);
        return remember(key, rows.map((r) => ({ name: shortName(r.display_name), address: String(r.display_name || "").split(",").slice(1).join(",").trim(), latitude: Number(r.lat), longitude: Number(r.lon), source: "osm" })).filter(inRwanda));
    } finally { osmPending--; }
}

// ─── Google (optional, paid) ─────────────────────────────────────────────────
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
    return (res.data.places || []).map((p) => ({ name: p.displayName?.text || shortName(p.formattedAddress), address: p.formattedAddress || "", latitude: p.location.latitude, longitude: p.location.longitude, source: "google" })).filter(inRwanda);
}

// ─── MOTA places (from ride history) ─────────────────────────────────────────
const normalize = (text) => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const GENERIC = /^(current location|selected location|pinned location|my location|dropped pin|pickup|destination|home|work|unknown|\s*-?\d+(\.\d+)?\s*-?\d+(\.\d+)?)$/;
const MIN_PASSENGERS = 3; // a place must be used by 3+ different passengers before others see it
let motaPlaces = [];
let motaBuiltAt = 0;
let motaBuilding = null;

/** Popular destinations of the last 180 days, grouped by name and ~100 m spot. */
async function rebuildMotaPlaces() {
    const Ride = require("../models/Ride");
    const since = new Date(Date.now() - 180 * 24 * 3600 * 1000);
    const rows = await Ride.aggregate([
        { $match: { rideStatus: "completed", createdAt: { $gte: since }, "destination.name": { $type: "string" }, "destination.latitude": { $type: "number" } } },
        { $project: { name: "$destination.name", address: "$destination.address", lat: "$destination.latitude", lng: "$destination.longitude", passengerId: 1, key: { $concat: [{ $toLower: { $trim: { input: "$destination.name" } } }, "@", { $toString: { $round: ["$destination.latitude", 3] } }, ",", { $toString: { $round: ["$destination.longitude", 3] } }] } } },
        { $group: { _id: "$key", name: { $first: "$name" }, address: { $first: "$address" }, latitude: { $avg: "$lat" }, longitude: { $avg: "$lng" }, rides: { $sum: 1 }, passengers: { $addToSet: "$passengerId" } } },
        { $project: { name: 1, address: 1, latitude: 1, longitude: 1, rides: 1, passengerCount: { $size: "$passengers" } } },
        { $match: { passengerCount: { $gte: MIN_PASSENGERS } } },
        { $sort: { rides: -1 } },
        { $limit: 3000 },
    ]);
    motaPlaces = rows
        .filter((r) => !GENERIC.test(normalize(r.name)) && inRwanda(r))
        .map((r) => ({ name: r.name.trim(), address: r.address || "", latitude: r.latitude, longitude: r.longitude, rides: r.rides, norm: normalize(r.name), source: "mota" }));
    motaBuiltAt = Date.now();
    return motaPlaces;
}

async function ensureMotaPlaces() {
    if (Date.now() - motaBuiltAt < 6 * 3600 * 1000) return motaPlaces;
    if (require("mongoose").connection.readyState !== 1) return motaPlaces; // no database yet: search the providers only
    if (!motaBuilding) motaBuilding = rebuildMotaPlaces().catch((error) => { console.warn("MOTA places index failed:", error.message); motaBuiltAt = Date.now() - 5.5 * 3600 * 1000; return motaPlaces; }).finally(() => { motaBuilding = null; });
    return motaPlaces.length ? motaPlaces : motaBuilding; // first build waits; later rebuilds run in the background
}

/** Every typed word must start a word of the place name ("kimi mark" → "Kimironko Market"). */
function motaMatches(q, limit = 4) {
    const words = normalize(q).split(" ").filter(Boolean);
    if (!words.length) return [];
    return motaPlaces
        .filter((p) => { const nameWords = p.norm.split(" "); return words.every((w) => nameWords.some((n) => n.startsWith(w))); })
        .sort((a, b) => b.rides - a.rides)
        .slice(0, limit)
        .map(({ norm, rides, ...p }) => p);
}

// ─── Merging ─────────────────────────────────────────────────────────────────
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
    if (na === nb && normalize(a.address) && normalize(a.address) === normalize(b.address)) return true; // would look identical in the list
    const meters = metersBetween(a, b);
    if (na === nb) return meters < ((a.area || b.area) ? 5000 : 500); // one neighbourhood can be listed as both a point and an outline

    if ((na.includes(nb) || nb.includes(na)) && meters < 150) return true;
    return meters < 100 && wordOverlap(na, nb) >= 0.5;
}
/** Earlier lists win; later lists only add places not already there. A trailing number is the limit. */
function mergePlaces(...lists) {
    const limit = typeof lists[lists.length - 1] === "number" ? lists.pop() : 10;
    const out = [];
    for (const place of lists.flat()) {
        if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        if (out.some((kept) => samePlace(kept, place))) continue;
        out.push(place);
        if (out.length >= limit) break;
    }
    return out;
}

const quiet = (label) => (error) => { console.warn(`${label} search failed:`, error.response?.data?.error?.message || error.message); return null; };

async function searchPlaces(query, near) {
    const q = String(query || "").trim().slice(0, 120);
    if (q.length < 3) return [];
    const area = near ? `${near.latitude.toFixed(1)},${near.longitude.toFixed(1)}` : "rw";
    const key = `s:${area}:${q.toLowerCase()}`;
    const hit = cached(key);
    if (hit) return hit;

    await ensureMotaPlaces();
    const mota = motaMatches(q);
    const [photon, google] = await Promise.all([
        photonSearch(q, near).catch(quiet("Photon")),
        googleEnabled() ? googleSearch(q, near).catch(quiet("Google Places")) : [],
    ]);
    // Nominatim only when Photon is down or found nothing (keeps us within its usage policy).
    const nominatimRows = !photon || !photon.length ? await nominatimSearch(q).catch(quiet("Nominatim")) : [];
    if (photon === null && nominatimRows === null && !mota.length && !(google && google.length)) throw new Error("Place search is unavailable right now.");
    const results = mergePlaces(mota, google || [], photon || [], nominatimRows || []).map(publicPlace);
    // Cache only answers from a working main provider, so a temporary outage isn't remembered.
    return results.length && photon !== null ? remember(key, results) : results;
}

async function reverseGeocode({ latitude, longitude }) {
    const key = `r:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const hit = cached(key);
    if (hit) return hit;
    const viaPhoton = await photonReverse({ latitude, longitude }).catch(() => null);
    if (viaPhoton) return remember(key, viaPhoton);
    const row = await nominatim(`/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=18`);
    return remember(key, { name: shortName(row?.display_name) || "Selected location", address: row?.display_name || "", latitude, longitude });
}

module.exports = { searchPlaces, reverseGeocode, mergePlaces, rebuildMotaPlaces, motaMatches };
