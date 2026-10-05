const router = require("express").Router();
const mongoose = require("mongoose");
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  effectivePermissions,
  validateGrant,
  scoped,
} = require("../services/reportAccess");
const reports = require("../services/reportService");
const User = require("../models/User");
const Audit = require("../models/AuditLog");
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.status === 403)
      void require("../services/auditService").log({
        actorId: req.user?._id,
        actorRole: req.user?.role,
        action: "access_denied",
        targetType: "Report",
        metadata: { path: req.originalUrl.split("?")[0] },
        ipAddress: req.ip,
      });
    res
      .status(error.status || 503)
      .json({
        message: error.status
          ? error.message
          : "Report is unavailable. Please retry; no missing data was replaced with zero.",
      });
  }
};
router.use(protect, authorize("admin:access"), (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const exportLimit = require("express-rate-limit").rateLimit({
  windowMs: 60000,
  limit: 5,
  keyGenerator: (req) => String(req.user._id),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Please wait a minute before requesting more exports." },
});
router.get("/access/me", (req, res) =>
  res.json({ data: { permissions: effectivePermissions(req.user), scoped } }),
);
router.get(
  "/access/users",
  authorize("data:access_manage"),
  handle(async (req, res) => {
    const q = String(req.query.q || "")
      .slice(0, 80)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = {
      role: {
        $in: [
          "admin",
          "financial",
          "agent",
          "caller_support",
          "manager",
          "moderator",
        ],
      },
      deletedAt: null,
    };
    if (q)
      match.$or = [
        { firstName: { $regex: q, $options: "i" } },
        { lastName: { $regex: q, $options: "i" } },
      ];
    const users = await User.find(match)
      .select("firstName lastName role roleId reportPermissions isActive")
      .populate("roleId", "permissions")
      .limit(50)
      .lean();
    res.json({
      data: users.map((u) => ({
        ...u,
        permissions: effectivePermissions(u).filter((p) => scoped.includes(p)),
      })),
      limit: 50,
    });
  }),
);
router.put(
  "/access/users/:id",
  authorize("data:access_manage"),
  handle(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      const e = new Error("Invalid user ID.");
      e.status = 400;
      throw e;
    }
    const permissions = validateGrant(req.user, req.body.permissions);
    await mongoose.connection.transaction(async (session) => {
      const user = await User.findById(req.params.id)
        .session(session)
        .populate("roleId", "permissions");
      if (
        !user ||
        ![
          "admin",
          "financial",
          "agent",
          "caller_support",
          "manager",
          "moderator",
        ].includes(user.role)
      ) {
        const e = new Error(
          "Select an existing staff account. Superadmin access cannot be changed here.",
        );
        e.status = 400;
        throw e;
      }
      const before = effectivePermissions(user).filter((p) =>
        scoped.includes(p),
      );
      user.reportPermissions = permissions;
      await user.save({ session });
      await Audit.create(
        [
          {
            actorId: req.user._id,
            actorRole: req.user.role,
            action: "report_access_updated",
            targetType: "User",
            targetId: user._id,
            metadata: { before, after: permissions },
            ipAddress: req.ip,
          },
        ],
        { session },
      );
    });
    res.json({
      message:
        "Reporting access saved. The user’s next request uses these permissions.",
    });
  }),
);
router.get(
  "/summary",
  handle(async (req, res) =>
    res.json({ data: await reports.summary(req.user, req.query) }),
  ),
);
router.get(
  "/records/:section",
  handle(async (req, res) =>
    res.json({
      data: await reports.records(req.user, req.params.section, req.query),
    }),
  ),
);
router.get(
  "/investigate/:type/:id",
  handle(async (req, res) =>
    res.json({
      data: await reports.investigate(
        req.user,
        req.params.type,
        req.params.id,
        req.query,
      ),
    }),
  ),
);
router.get(
  "/export/:section/:format",
  exportLimit,
  handle(async (req, res) => {
    const { section, format } = req.params;
    reports.ensure(req.user, section, true);
    if (!["pdf", "xlsx"].includes(format)) {
      const e = new Error("Choose PDF or XLSX.");
      e.status = 400;
      throw e;
    }
    const query = { ...req.query, section, page: 1 };
    const [summary, records] = await Promise.all([
      reports.summary(req.user, query),
      reports.records(req.user, section, query, 2000),
    ]);
    const exporter = require("../services/reportExport");
    const sheets = exporter.flattenReport(summary, records);
    const buffer =
      await exporter[format === "pdf" ? "pdf" : "spreadsheet"](sheets);
    // A durable audit entry is required before any export bytes leave the server.
    await Audit.create({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: "report_exported",
      targetType: "Report",
      metadata: {
        section,
        format,
        period: summary.period,
        filters: {
          q: query.q || "",
          status: query.status || "",
          role: query.role || "",
        },
        rows: records.rows.length,
        total: records.total,
        capped: records.total > 2000,
      },
      ipAddress: req.ip,
    });
    res.set("Cache-Control", "no-store");
    res.type(
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.attachment(
      `mota-${section}-${new Date().toISOString().slice(0, 10)}.${format}`,
    );
    res.send(buffer);
  }),
);
module.exports = router;
