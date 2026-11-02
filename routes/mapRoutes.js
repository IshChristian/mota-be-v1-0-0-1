const express = require("express");
const axios = require("axios");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(protect);

router.post("/route", async (req, res) => {
  const { origin, destination } = req.body;
  const valid = (point) => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude);
  if (!valid(origin) || !valid(destination)) return res.status(400).json({ message: "Valid origin and destination coordinates are required" });
  // Google Routes first, OpenStreetMap (OSRM) when Google fails or finds no route.
  const route = await require("../services/routingService").getRoute(origin, destination);
  if (!route) return res.status(404).json({ message: "No road route found. The map shows a straight line instead." });
  res.json({ data: { ...route, duration: `${route.durationSeconds}s` } });
});

const geocode = require("../services/geocodeService");
const readPoint = (lat, lng) => {
  const latitude = Number(lat), longitude = Number(lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
};

/** GET /api/maps/search?q=…&lat=&lng= — places in Rwanda from free sources (MOTA places, Photon, Nominatim; Google only if PLACES_GOOGLE_ENABLED). Cached. */
router.get("/search", async (req, res) => {
  try {
    res.json({ data: await geocode.searchPlaces(req.query.q, readPoint(req.query.lat, req.query.lng) || undefined) });
  } catch (error) {
    res.status(503).json({ message: "Place search is busy. Try again in a moment, or tap the map." });
  }
});

/** GET /api/maps/reverse?lat=&lng= — a readable name for a tapped point. */
router.get("/reverse", async (req, res) => {
  const point = readPoint(req.query.lat, req.query.lng);
  if (!point) return res.status(400).json({ message: "Valid lat and lng are required." });
  try { res.json({ data: await geocode.reverseGeocode(point) }); }
  catch { res.json({ data: { name: "Selected location", address: "", ...point } }); }
});

module.exports = router;
