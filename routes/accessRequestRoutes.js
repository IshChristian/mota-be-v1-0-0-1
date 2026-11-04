const express = require("express");
const mongoose = require("mongoose");
const { protect, authorize } = require("../middleware/authMiddleware");
const service = require("../services/accessRequestService");

const router = express.Router();
router.use(protect);
router.use(authorize("admin:access"));

const handle = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : "Unable to process the access request" }); }
};
// Approving is the superadmin's alone, whatever permissions a role carries.
const superadminOnly = (req, res, next) => (req.user.role === "superadmin" ? next() : res.status(403).json({ message: "Only the superadmin can decide access requests." }));

router.post("/", handle(async (req, res) => {
    const { request, created } = await service.createRequest(req.user, req.body || {}, req.ip);
    res.status(created ? 201 : 200).json({ message: created ? "Access requested" : "Already requested", data: request });
}));
router.get("/", handle(async (req, res) => {
    const mine = req.query.mine === "1" || req.user.role !== "superadmin";
    res.json({ data: await service.listRequests({ requesterId: mine ? req.user._id : undefined, status: req.query.status }) });
}));
for (const decision of ["approve", "decline"]) {
    router.post(`/:id/${decision}`, superadminOnly, handle(async (req, res) => {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid request ID" });
        res.json({ message: `Request ${decision}d`, data: await service.decideRequest(req.user, req.params.id, decision, req.body?.note, req.ip) });
    }));
}

module.exports = router;
