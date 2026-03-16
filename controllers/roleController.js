const roleService = require("../services/roleService");

const createRole = async (req, res) => {
    try {
        const { name, description, permissions } = req.body;
        if (!name) return res.status(400).json({ message: "Role name is required" });

        const existing = await roleService.getRoleByName(name);
        if (existing) return res.status(400).json({ message: "Role already exists" });

        const role = await roleService.createRole(name, description, permissions || []);
        res.status(201).json({ message: "Role created", data: role });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getRoles = async (req, res) => {
    try {
        const roles = await roleService.getRoles();
        res.status(200).json({ data: roles });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateRole = async (req, res) => {
    try {
        const { permissions } = req.body;
        const role = await roleService.updateRolePermissions(req.params.id, permissions);
        if (!role) return res.status(404).json({ message: "Role not found" });

        res.status(200).json({ message: "Role updated", data: role });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    createRole,
    getRoles,
    updateRole,
};
