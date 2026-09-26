const bcrypt = require("bcrypt");
const User = require("../models/User");
const Role = require("../models/Role");
const auditService = require("../services/auditService");

const operationalPermissions = new Set([
    "admin:access", "analytics:view", "user:view", "driver:view", "driver:location",
    "ride:view", "registration:view", "kyc:view", "support:view", "support:update",
    "notification:send", "call_log:create", "audit:view", "search:universal",
]);
const reserved = new Set(["superadmin", "admin", "financial", "agent", "caller_support", "client", "driver", "manager", "moderator"]);

exports.createOperationalStaff = async (req, res) => {
    try {
        const { firstName, lastName, phone, email, password, roleId } = req.body;
        if (![firstName, lastName, phone, password, roleId].every(value => typeof value === "string" && value.trim())) return res.status(400).json({ message: "Name, phone, password, and role are required" });
        if (password.length < 8) return res.status(400).json({ message: "Password must contain at least 8 characters" });
        const role = await Role.findById(roleId);
        if (!role || reserved.has(role.name)) return res.status(400).json({ message: "Select a custom operational role" });
        if (!role.permissions.includes("admin:access") || role.permissions.some(permission => !operationalPermissions.has(permission))) return res.status(400).json({ message: "This role is not available for operational account creation" });
        const account = await User.create({ firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), email: email?.trim().toLowerCase() || undefined, password: await bcrypt.hash(password, 12), role: "moderator", roleId: role._id, isActive: true, isVerified: true });
        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "user_created", targetType: "User", targetId: account._id, metadata: { roleId: String(role._id), roleName: role.name }, ipAddress: req.ip });
        res.status(201).json({ message: "Operational staff account created", data: { _id: account._id, firstName: account.firstName, lastName: account.lastName, role: account.role, roleId: role._id } });
    } catch (error) {
        res.status(error.code === 11000 ? 409 : 400).json({ message: error.code === 11000 ? "Phone or email already exists" : "Unable to create staff account" });
    }
};
