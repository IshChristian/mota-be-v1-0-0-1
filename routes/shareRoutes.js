// Public, read-only trip tracking for people a passenger shared their ride with.
const express = require("express");
const riderFeatures = require("../services/riderFeaturesService");

const STATUS = {
    requested: "Looking for a driver", searching: "Looking for a driver", accepted: "Driver on the way", approaching: "Driver on the way",
    arrived: "Driver at pickup", start_requested: "Starting", in_progress: "On the way to destination", stop_requested: "Arriving",
    awaiting_payment: "Arrived",
};
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const api = express.Router();
api.get("/:token", async (req, res) => {
    try {
        const trip = await riderFeatures.publicTrip(req.params.token);
        res.set("Cache-Control", "no-store");
        if (!trip) return res.status(404).json({ message: "This trip link has expired." });
        res.json({ data: trip });
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
});

const page = express.Router();
page.get("/:token", async (req, res) => {
    const trip = await riderFeatures.publicTrip(req.params.token).catch(() => null);
    res.set("Cache-Control", "no-store");
    // The page is self-contained; allow its inline styles under helmet's CSP.
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
    if (!trip) {
        return res.status(404).type("html").send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTA trip</title><body style="font-family:system-ui;padding:24px"><h1>Trip link expired</h1><p>This ride has ended or the link is no longer valid.</p>');
    }
    const loc = trip.driver?.location;
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>${esc(trip.passengerFirstName)}'s MOTA trip</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#fafafa;color:#111}main{max-width:480px;margin:auto}.card{background:#fff;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 3px #0002}.status{font-size:20px;font-weight:700;color:#b91c1c}a.btn{display:block;text-align:center;background:#b91c1c;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}small{color:#555}</style></head>
<body><main><h1>${esc(trip.passengerFirstName)} is riding with MOTA</h1>
<div class="card"><div class="status">${esc(STATUS[trip.rideStatus] || trip.rideStatus)}</div><p>From <b>${esc(trip.pickup.name)}</b><br>To <b>${esc(trip.destination.name)}</b></p></div>
${trip.driver ? `<div class="card"><b>Driver:</b> ${esc(trip.driver.firstName)}<br><b>Plate:</b> ${esc(trip.driver.plate)}<br><b>Vehicle:</b> ${esc(trip.driver.vehicle)}</div>` : ""}
${loc ? `<a class="btn" href="https://maps.google.com/?q=${Number(loc.latitude)},${Number(loc.longitude)}">See live location on map</a><p><small>Updated ${esc(new Date(loc.at).toLocaleTimeString("en-GB", { timeZone: "Africa/Kigali" }))} · refreshes every 20 s</small></p>` : ""}
<p><small>In an emergency call 112.</small></p></main></body></html>`);
});

module.exports = { api, page };
