const {
  REPORT_PERMISSIONS,
  PERMISSIONS,
  STAFF_ROLE_TEMPLATES,
} = require("../constants/staffRoles");
const scoped = [...REPORT_PERMISSIONS, "analytics:view", "audit:view"];
function effectivePermissions(user) {
  if (user.role === "superadmin") return [...PERMISSIONS];
  if (
    ![
      "admin",
      "financial",
      "agent",
      "caller_support",
      "manager",
      "moderator",
    ].includes(user.role)
  )
    return [];
  const base =
    user.roleId?.permissions || STAFF_ROLE_TEMPLATES[user.role] || [];
  if (!Array.isArray(user.reportPermissions)) return [...base];
  return [
    ...new Set([
      ...base.filter((p) => !scoped.includes(p)),
      ...user.reportPermissions.filter((p) => scoped.includes(p)),
    ]),
  ];
}
function validateGrant(actor, requested) {
  if (!Array.isArray(requested) || requested.some((p) => !scoped.includes(p))) {
    const e = new Error("Unknown reporting permission.");
    e.status = 400;
    throw e;
  }
  if (
    requested.some((p) =>
      /^analytics:(users|rides|finance|operations|export)$/.test(p),
    ) &&
    !requested.includes("analytics:view")
  ) {
    const e = new Error("Analytics permissions require analytics:view.");
    e.status = 400;
    throw e;
  }
  if (
    requested.some((p) => ["audit:export", "audit:sensitive"].includes(p)) &&
    !requested.includes("audit:view")
  ) {
    const e = new Error("Audit export/sensitive access requires audit:view.");
    e.status = 400;
    throw e;
  }
  const own = effectivePermissions(actor);
  if (
    actor.role !== "superadmin" &&
    requested.some((p) => !own.includes(p) || p === "data:access_manage")
  ) {
    const e = new Error(
      "You cannot grant reporting access beyond your own permissions.",
    );
    e.status = 403;
    throw e;
  }
  return [...new Set(requested)];
}
module.exports = { effectivePermissions, validateGrant, scoped };
