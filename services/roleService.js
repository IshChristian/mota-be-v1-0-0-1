const Role = require("../models/Role");

const createRole = async (name, description, permissions) => {
    return await Role.create({ name, description, permissions });
};

const getRoleByName = async (name) => {
    return await Role.findOne({ name });
};

const getRoles = async () => {
    return await Role.find({});
};

const updateRolePermissions = async (id, permissions) => {
    return await Role.findByIdAndUpdate(id, { permissions }, { new: true });
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
