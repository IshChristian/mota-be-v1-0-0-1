// Road routes for fares, maps and directions.
// Primary: Google Routes API (GOOGLE_ROUTES_API_KEY or GOOGLE_MAPS_API_KEY).
// Fallback: OSRM, the OpenStreetMap routing engine (OSRM_URL; public demo server by default).
// Each covers for the other: an error or "no route" from one tries the next.
const axios = require("axios");

const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

const googleKey = () => process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "";
// Set OSRM_URL to "" to disable (tests do); point it at your own OSRM for production traffic.
const osrmUrl = () => (process.env.OSRM_URL === undefined ? "https://router.project-osrm.org" : process.env.OSRM_URL).replace(/\/+$/, "");

const key = (o, d) => [o.latitude, o.longitude, d.latitude, d.longitude].map((n) => Number(n).toFixed(4)).join(",");

async function google(origin, destination) {
    const res = await axios.post("https://routes.googleapis.com/directions/v2:computeRoutes", {
        origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
        destination: { location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        computeAlternativeRoutes: false,
        languageCode: "en",
        units: "METRIC",
    }, {
        headers: { "X-Goog-Api-Key": googleKey(), "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction" },
        timeout: 8000,
    });
    const route = res.data?.routes?.[0];
    if (!route?.distanceMeters) return null;
    const steps = (route.legs || []).flatMap((leg) => leg.steps || []).map((s) => ({
        instruction: s.navigationInstruction?.instructions || "",
        maneuver: s.navigationInstruction?.maneuver || "",
        distanceMeters: s.distanceMeters || 0,
    })).filter((s) => s.instruction);
    return { source: "google", encodedPolyline: route.polyline?.encodedPolyline, distanceMeters: route.distanceMeters, durationSeconds: Number(String(route.duration || "0s").replace("s", "")), steps };
}

const osrmInstruction = (step) => {
    const m = step.maneuver || {};
    const road = step.name || "";
    const onto = road ? ` onto ${road}` : "";
    const dir = m.modifier ? m.modifier.replace("sharp ", "sharp ").replace("slight ", "slightly ") : "";
    switch (m.type) {
        case "depart": return road ? `Start on ${road}` : "Start driving";
        case "arrive": return "Arrive at your destination";
        case "roundabout": case "rotary": return `At the roundabout, take exit ${m.exit || 1}${onto}`;
        case "exit roundabout": case "exit rotary": return `Exit the roundabout${onto}`;
        case "turn": case "end of road": return `Turn ${dir || "ahead"}${onto}`;
        case "fork": return `Keep ${dir || "straight"}${onto}`;
        case "merge": return `Merge${onto}`;
        case "new name": return `Continue${onto}`;
        default: return dir && dir !== "straight" ? `Keep ${dir}${onto}` : `Continue${onto}`;
    }
};

async function osrm(origin, destination) {
    if (!osrmUrl()) return null;
    const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const res = await axios.get(`${osrmUrl()}/route/v1/driving/${coords}`, { params: { overview: "full", geometries: "polyline", steps: true }, timeout: 8000, headers: { "User-Agent": "MOTA-Backend/1.0" } });
    const route = res.data?.routes?.[0];
    if (res.data?.code !== "Ok" || !route) return null;
    const steps = (route.legs || []).flatMap((leg) => leg.steps || []).map((s) => ({ instruction: osrmInstruction(s), maneuver: [s.maneuver?.type, s.maneuver?.modifier].filter(Boolean).join("_"), distanceMeters: Math.round(s.distance || 0) }));
    return { source: "osm", encodedPolyline: route.geometry, distanceMeters: Math.round(route.distance), durationSeconds: Math.round(route.duration), steps };
}

/** Returns a road route, or null when neither provider can route (callers fall back to straight-line estimates). */
async function getRoute(origin, destination) {
    const k = key(origin, destination);
    const hit = cache.get(k);
    if (hit && hit.expires > Date.now()) return hit.value;
    const providers = googleKey() ? [google, osrm] : [osrm];
    let route = null;
    for (const provider of providers) {
        try { route = await provider(origin, destination); } catch (error) { console.warn(`Routing via ${provider.name} failed:`, error.response?.status || error.message); }
        if (route) break;
    }
    if (route) {
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
        cache.set(k, { value: route, expires: Date.now() + TTL_MS });
    }
    return route;
}

module.exports = { getRoute, _osrmInstruction: osrmInstruction, _clearCache: () => cache.clear() };
