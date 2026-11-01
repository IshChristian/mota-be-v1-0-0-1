const valid = (p) => Number.isFinite(p?.latitude) && Number.isFinite(p?.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
async function getRoadRoute(origin, destination) {
    if (!valid(origin) || !valid(destination)) throw new Error("Valid pickup and destination coordinates are required.");
    const key = process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    try {
        const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
            method: "POST", signal: AbortSignal.timeout(8000),
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration" },
            body: JSON.stringify({ origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } }, destination: { location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } } }, travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE" }),
        });
        if (!response.ok) return null;
        const route = (await response.json()).routes?.[0];
        const seconds = Number(String(route?.duration || "").replace(/s$/, ""));
        if (!Number.isFinite(route?.distanceMeters) || route.distanceMeters < 0 || !Number.isFinite(seconds) || seconds < 0) return null;
        return { distanceKm: route.distanceMeters / 1000, durationMinutes: Math.ceil(seconds / 60), distanceSource: "road" };
    } catch { return null; }
}
module.exports = { getRoadRoute, valid };
