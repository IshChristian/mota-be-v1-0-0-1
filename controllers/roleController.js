const mongoose = require("mongoose");
const { PERMISSIONS } = require("../constants/staffRoles");
const { effectivePermissions } = require("../services/reportAccess");
const { validateRoleGrant, roleAccountType } = require("../services/rolePermissions");
const roleService = require("../services/roleService");
const auditService = require("../services/auditService");

const createRole = async (req, res) => {
    try {
        const { description, permissions } = req.body;
        const name = String(req.body.name || "").trim().toLowerCase().replace(/\s+/g,"_");
        if (!/^[a-z][a-z0-9_]{2,31}$/.test(name)) return res.status(400).json({message:"Use 3–32 letters, numbers or underscores for the role name."});
        if (name === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({message:"Only superadmin can manage the ownership role."});
        if (["driver", "client", "passenger"].includes(name)) return res.status(400).json({message:"Choose a staff role name; rider and driver are account types."});
        if (!name) return res.status(400).json({ message: "Role name is required" });

        const existing = await roleService.getRoleByName(name);
        if (existing) return res.status(400).json({ message: "Role already exists" });

        if (!Array.isArray(permissions || [])) return res.status(400).json({ message: "Permissions must be an array." });
        validateRoleGrant(req.user, permissions || []);
        const role = await roleService.createRole(name, description, permissions || []);
        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "role_created", targetType: "Role", targetId: role._id, metadata: { name: role.name, permissions: role.permissions }, ipAddress: req.ip });
        res.status(201).json({ message: "Role created", data: role });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.status ? error.message : "Server error", error: error.message });
    }
};

const getRoles = async (req, res) => {
    try {
        const roles = await roleService.getRoles();
        res.status(200).json({ data: roles });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.status ? error.message : "Server error", error: error.message });
    }
};

const updateRole = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:"Invalid role ID"});
        const { permissions } = req.body;
        if (!Array.isArray(permissions)) return res.status(400).json({ message: "Permissions must be an array." });
        validateRoleGrant(req.user, permissions);
        const previousRole = await roleService.getRoleById(req.params.id);
        if (previousRole?.name === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({message:"Only superadmin can manage the ownership role."});
        const role = await roleService.updateRolePermissions(req.params.id, permissions);
        if (!role) return res.status(404).json({ message: "Role not found" });

        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "role_updated", targetType: "Role", targetId: role._id, metadata: { before: { permissions: previousRole?.permissions }, after: { permissions: role.permissions } }, ipAddress: req.ip });
        res.status(200).json({ message: "Role updated", data: role });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.status ? error.message : "Server error", error: error.message });
    }
};

const deleteRole = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:"Invalid role ID"});
        const role = await roleService.getRoleById(req.params.id);
        if (!role) return res.status(404).json({ message: "Role not found" });
        if (["superadmin", "admin"].includes(role.name)) return res.status(400).json({ message: "Core administrative roles cannot be deleted" });
        if (await require("../models/User").exists({roleId:req.params.id})) return res.status(409).json({message:"Reassign users before deleting their role."});
        validateRoleGrant(req.user, role.permissions);
        await roleService.deleteRole(req.params.id);
        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "role_deleted", targetType: "Role", targetId: role._id, metadata: { name: role.name }, ipAddress: req.ip });
        res.status(200).json({ message: "Role deleted" });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.status ? error.message : "Server error", error: error.message });
    }
};

const permissionCatalog = (req,res) => {
  const own=effectivePermissions(req.user);
  const groups={}; for(const permission of PERMISSIONS){const category=permission.split(':')[0];(groups[category] ||= []).push(permission);}
  res.json({data:{permissions:PERMISSIONS,groups,grantable:PERMISSIONS.filter(p=>req.user.role==='superadmin'||own.includes(p)&&p!=='data:access_manage')}});
};
const assignableRoles = async (req,res) => {
  const own=effectivePermissions(req.user);
  if(!own.includes('user:create')&&!own.includes('user:assign_role'))return res.status(403).json({message:'User creation or role assignment permission is required.'});
  try {const roles=await roleService.getRoles();res.json({data:roles.filter(role=>{try{validateRoleGrant(req.user,role.permissions);return role.name!=='superadmin'||req.user.role==='superadmin';}catch{return false;}}).map(role=>({_id:role._id,name:role.name,description:role.description,permissions:role.permissions,accountType:roleAccountType(role)}))});}catch{res.status(500).json({message:'Unable to load assignable roles.'});}
};
module.exports = { permissionCatalog, assignableRoles,
    createRole,
    getRoles,
    updateRole,
    deleteRole,
};
