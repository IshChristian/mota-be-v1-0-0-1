const { PERMISSIONS, STAFF_ROLES } = require('../constants/staffRoles');
const { effectivePermissions, validateGrant, scoped } = require('./reportAccess');
function validateRoleGrant(actor, permissions) {
  if (!Array.isArray(permissions) || permissions.some(p => typeof p !== 'string' || !PERMISSIONS.includes(p))) throw Object.assign(new Error('Unknown permissions. Use the system permission catalog.'), {status:400});
  validateGrant(actor, permissions.filter(p=>scoped.includes(p)));
  const own = effectivePermissions(actor);
  if (actor.role !== 'superadmin' && permissions.some(p=>!own.includes(p))) throw Object.assign(new Error('You cannot grant permissions beyond your own access.'), {status:403});
  return [...new Set(permissions)];
}
function roleAccountType(record) { return [...STAFF_ROLES,'manager','moderator'].includes(record.name) ? record.name : 'manager'; }
function matchesRole(record, role) { return !!record && roleAccountType(record) === role; }
module.exports = { validateRoleGrant, roleAccountType, matchesRole };
