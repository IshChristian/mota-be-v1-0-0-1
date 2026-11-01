// Thin wrapper over services/reportAccess.js (the permission rules used by
// authorize() and the admin dashboard), kept for callers that use can().
const { effectivePermissions } = require("./reportAccess");

const can = (user, permission) => effectivePermissions(user).includes(permission);

module.exports = { effectivePermissions, can };
