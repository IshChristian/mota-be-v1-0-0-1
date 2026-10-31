const express = require("express");
const router = express.Router();
const sseService = require("../services/sseService");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const User = require("../models/User");
const rideEngineService = require("../services/rideEngineService");

/**
 * @swagger
 * /api/realtime/driver-events:
 *   get:
 *     summary: Subscribe to real-time driver events (SSE)
 *     description: Server-Sent Events channel for drivers to receive instant ride requests and updates. Must send Bearer token in query string or header.
 *     tags: [Realtime]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: SSE stream connected
 */
router.get("/driver-events", authMiddleware, (req, res) => {
    // Add this client to the SSE manager
    sseService.addClient(req.user.id, res, req);
});

// One live stream for every signed-in app (passengers and drivers): ride
// updates, offers, counter-offers, chat, payments and driver location.
router.get("/events", authMiddleware, (req, res) => {
    sseService.addClient(req.user.id, res, req);
});

router.post("/location", authMiddleware, async (req, res) => {
    try {
        const { latitude, longitude, heading, speed } = req.body;
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
            !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            return res.status(400).json({ message: "Valid latitude and longitude are required." });
        }
        // Same path as PUT /api/driver/location, so the passenger's map updates live.
        await rideEngineService.updateDriverLocation(req.user.id, latitude, longitude, heading, speed);
        res.status(200).json({ message: "Location updated." });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

router.get("/nearby-drivers", authMiddleware, async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const radius = Math.min(Math.max(Number(req.query.radius) || 3, 0.5), 20);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ message: "Valid lat and lng query parameters are required." });
        }
        const vehicleType = req.query.vehicleType ? rideEngineService.normalizeVehicleType(req.query.vehicleType) : undefined;
        const drivers = await rideEngineService.findNearbyDrivers(lat, lng, radius, 25, { vehicleType, exclude: [req.user.id] });
        // Positions are rounded (~100 m) and names omitted: passengers see availability, not who is where.
        res.status(200).json({ data: drivers.map((driver) => ({
            id: driver._id,
            latitude: Math.round(driver.lastLocation.latitude * 1000) / 1000,
            longitude: Math.round(driver.lastLocation.longitude * 1000) / 1000,
            heading: driver.lastLocation.heading,
            distanceKm: Math.round(driver.distanceKm * 10) / 10,
        })) });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

module.exports = router;
