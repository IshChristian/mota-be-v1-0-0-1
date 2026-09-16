const Role = require("../models/Role");
const { PERMISSIONS } = require("../constants/staffRoles");

const validatePermissions = (permissions) => {
    const invalid = permissions.filter(permission => !PERMISSIONS.includes(permission));
    if (invalid.length) throw new Error(`Unknown permissions: ${invalid.join(", ")}`);
    return [...new Set(permissions)];
};

const createRole = async (name, description, permissions) => {
    return await Role.create({ name, description, permissions: validatePermissions(permissions) });
};

const getRoleByName = async (name) => {
    return await Role.findOne({ name });
};

const getRoles = async () => {
    return await Role.find({});
};

const updateRolePermissions = async (id, permissions) => {
    return await Role.findByIdAndUpdate(id, { permissions: validatePermissions(permissions) }, { new: true, runValidators: true });
};

const deleteRole = async (id) => {
    return await Role.findByIdAndDelete(id);
};

module.exports = {
    createRole,
    getRoleByName,
    getRoles,
    updateRolePermissions,
    deleteRole,
};
