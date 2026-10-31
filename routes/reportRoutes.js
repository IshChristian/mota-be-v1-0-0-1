// /api/reports — staff access, analysis summaries, records, investigations and exports.
const express = require("express");
const mongoose = require("mongoose");
const { protect } = require("../middleware/authMiddleware");
const User = require("../models/User");
const access = require("../services/accessService");
const reports = require("../services/reportService");
const auditService = require("../services/auditService");

const router = express.Router();
router.use(protect);

const perms = (req) => access.effectivePermissions(req.user);
const need = (...anyOf) => (req, res, next) => (anyOf.some((p) => perms(req).includes(p)) ? next() : res.status(403).json({ message: "You don't have access to this." }));
const fail = (res, error) => res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Report could not be generated." });
const STAFF_FILTER = { role: { $nin: ["client", "driver"] }, deletedAt: null };

// The dashboard loads this on login and every minute; server checks still apply per request.
router.get("/access/me", (req, res) => res.json({ data: { permissions: perms(req), role: req.user.role } }));

router.get("/access/users", need("data:access_manage"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = { ...STAFF_FILTER, ...(q ? { $or: [{ firstName: new RegExp(safe, "i") }, { lastName: new RegExp(safe, "i") }] } : {}) };
    const staff = await User.find(filter).populate("roleId", "name permissions").select("firstName lastName role isActive roleId reportPermissions").limit(50);
    res.json({ data: staff.map((u) => ({ _id: u._id, firstName: u.firstName, lastName: u.lastName, role: u.role, isActive: u.isActive, permissions: access.effectivePermissions(u).filter((p) => access.REPORT_SCOPES.includes(p)), customized: Array.isArray(u.reportPermissions) })) });
});

router.put("/access/users/:id", need("data:access_manage"), async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Staff member not found." });
    const requested = Array.isArray(req.body.permissions) ? [...new Set(req.body.permissions.map(String))] : null;
    if (!requested) return res.status(400).json({ message: "permissions must be a list." });
    const unknown = requested.filter((p) => !access.REPORT_SCOPES.includes(p));
    if (unknown.length) return res.status(400).json({ message: `Not a reporting permission: ${unknown.join(", ")}` });
    const mine = perms(req);
    // Managers can only hand out scopes they hold themselves (superadmin holds all).
    const beyond = requested.filter((p) => !mine.includes(p));
    if (beyond.length) return res.status(403).json({ message: `You can't grant access you don't have: ${beyond.join(", ")}` });
    const target = await User.findOne({ _id: req.params.id, ...STAFF_FILTER }).populate("roleId", "name permissions");
    if (!target) return res.status(404).json({ message: "Staff member not found." });
    if (target.role === "superadmin") return res.status(400).json({ message: "Superadmin access can't be changed." });
    const before = access.effectivePermissions(target).filter((p) => access.REPORT_SCOPES.includes(p));
    target.reportPermissions = requested;
    await target.save();
    await auditService.log({ actorId: req.user._id, actorRole: req.user.role, action: "report_access_updated", targetType: "User", targetId: target._id, ipAddress: req.ip, metadata: { before, after: requested } });
    res.json({ message: "Reporting access saved", data: { _id: target._id, permissions: requested } });
});

router.get("/summary", need("analytics:view", "audit:view"), async (req, res) => {
    try { res.json({ data: await reports.summary(req.query, perms(req)) }); } catch (e) { fail(res, e); }
});
router.get("/records/:section", need("analytics:view", "audit:view"), async (req, res) => {
    try { res.json({ data: await reports.records(req.params.section, req.query, perms(req)) }); } catch (e) { fail(res, e); }
});
router.get("/investigate/:type/:id", need("audit:view"), async (req, res) => {
    try { res.json({ data: await reports.investigate(req.params.type, req.params.id, req.query, perms(req)) }); } catch (e) { fail(res, e); }
});

router.get("/export/:section/:format", async (req, res) => {
    const { section, format } = req.params;
    const exportScope = section === "security" ? "audit:export" : "analytics:export";
    if (!perms(req).includes(exportScope)) return res.status(403).json({ message: "Export permission is required." });
    if (!["pdf", "xlsx"].includes(format)) return res.status(400).json({ message: "Format must be pdf or xlsx." });
    try {
        const p = perms(req);
        const summary = await reports.summary({ ...req.query, section }, p);
        const detail = await reports.records(section, req.query, p, { max: 2000 });
        const file = await require("../services/reportExport")[format](section, summary, detail);
        await auditService.log({ actorId: req.user._id, actorRole: req.user.role, action: "report_exported", targetType: "Report", ipAddress: req.ip, metadata: { section, format, from: summary.period.from, to: summary.period.to, rows: detail.rows.length } });
        res.set("Content-Type", format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.set("Content-Disposition", `attachment; filename="mota-${section}-${summary.period.to}.${format}"`);
        res.send(file);
    } catch (e) { fail(res, e); }
});

module.exports = router;
