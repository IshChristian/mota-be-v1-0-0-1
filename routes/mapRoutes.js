const express = require("express");
const axios = require("axios");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(protect);

router.post("/route", async (req, res) => {
  try {
    const { origin, destination, travelMode = "DRIVE" } = req.body;
    const valid = (point) => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude);
    if (!valid(origin) || !valid(destination)) return res.status(400).json({ message: "Valid origin and destination coordinates are required" });

    const apiKey = process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(503).json({ message: "Google Routes API is not configured" });

    const response = await axios.post("https://routes.googleapis.com/directions/v2:computeRoutes", {
      origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
      destination: { location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } } },
      travelMode,
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: false,
      languageCode: "en-US",
      units: "METRIC",
    }, { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline" }, timeout: 10000 });

    const route = response.data?.routes?.[0];
    if (!route) return res.status(404).json({ message: "No route found" });
    res.json({ data: { encodedPolyline: route.polyline?.encodedPolyline, distanceMeters: route.distanceMeters, duration: route.duration } });
  } catch (error) {
    const status = error.response?.status || 502;
    res.status(status).json({ message: error.response?.data?.error?.message || "Unable to calculate route" });
  }
});

module.exports = router;
