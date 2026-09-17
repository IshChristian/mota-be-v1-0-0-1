const roleService = require("../services/roleService");
const auditService = require("../services/auditService");

const createRole = async (req, res) => {
    try {
        const { name, description, permissions } = req.body;
        if (!name) return res.status(400).json({ message: "Role name is required" });

        const existing = await roleService.getRoleByName(name);
        if (existing) return res.status(400).json({ message: "Role already exists" });

        const role = await roleService.createRole(name, description, permissions || []);
        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "role_created", targetType: "Role", targetId: role._id, metadata: { name: role.name, permissions: role.permissions }, ipAddress: req.ip });
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

        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "role_updated", targetType: "Role", targetId: role._id, metadata: { permissions: role.permissions }, ipAddress: req.ip });
        res.status(200).json({ message: "Role updated", data: role });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const deleteRole = async (req, res) => {
    try {
        const role = await roleService.getRoleById(req.params.id);
        if (!role) return res.status(404).json({ message: "Role not found" });
        if (["superadmin", "admin"].includes(role.name)) return res.status(400).json({ message: "Core administrative roles cannot be deleted" });
        await roleService.deleteRole(req.params.id);
        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "role_deleted", targetType: "Role", targetId: role._id, metadata: { name: role.name }, ipAddress: req.ip });
        res.status(200).json({ message: "Role deleted" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    createRole,
    getRoles,
    updateRole,
    deleteRole,
};
