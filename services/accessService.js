// Effective staff permissions, used by authorize() and the admin dashboard.
//
// Base permissions: the assigned Role document, else the role's template.
// Report scopes (analysis, audit, exports, access management) can be granted
// per user; an explicit grant REPLACES the inherited report scopes. Without a
// grant they are inherited from the base permissions. Superadmin has everything.
const { PERMISSIONS, STAFF_ROLE_TEMPLATES } = require("../constants/staffRoles");

const REPORT_SCOPES = [
    "analytics:view", "analytics:users", "analytics:rides", "analytics:finance", "analytics:operations", "analytics:export",
    "audit:view", "audit:export", "audit:sensitive", "data:access_manage",
];

function inheritedReportScopes(base) {
    const has = (p) => base.includes(p);
    const scopes = [];
    if (has("analytics:view")) scopes.push("analytics:view", "analytics:users", "analytics:rides", "analytics:operations");
    if (has("analytics:view") && (has("finance:view") || has("transaction:view"))) scopes.push("analytics:finance");
    if (has("audit:view")) scopes.push("audit:view");
    if (has("role:manage")) scopes.push("data:access_manage");
    return scopes;
}

function effectivePermissions(user) {
    if (!user) return [];
    if (user.role === "superadmin") return [...new Set([...PERMISSIONS, ...REPORT_SCOPES])];
    const base = user.roleId?.permissions || STAFF_ROLE_TEMPLATES[user.role] || [];
    const nonReport = base.filter((p) => !REPORT_SCOPES.includes(p));
    const report = Array.isArray(user.reportPermissions)
        ? user.reportPermissions.filter((p) => REPORT_SCOPES.includes(p))
        : inheritedReportScopes(base);
    return [...new Set([...nonReport, ...report])];
}

const can = (user, permission) => effectivePermissions(user).includes(permission);

module.exports = { REPORT_SCOPES, effectivePermissions, can };
