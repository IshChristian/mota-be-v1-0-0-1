const adminService = require("../services/adminService");
const userService = require("../services/userService");
const configService = require("../services/configService");
const SystemConfig = require("../models/SystemConfig");

const getUsersList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await userService.getUsers({}, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const banUserAccount = async (req, res) => {
    try {
        const user = await adminService.banUser(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ message: "User banned successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const unbanUserAccount = async (req, res) => {
    try {
        const user = await adminService.unbanUser(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ message: "User unbanned successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const deleteUserAccount = async (req, res) => {
    try {
        // Here admin deletes a user
        await userService.deleteUser(req.params.id);
        res.status(200).json({ message: "User account deleted entirely" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getStats = async (req, res) => {
    try {
        const stats = await adminService.getSystemStats();
        res.status(200).json({ data: stats });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateSystemConfig = async (req, res) => {
    try {
        const { key, value, description } = req.body;
        if (!key || value === undefined) {
            return res.status(400).json({ message: "Key and value are required" });
        }
        const config = await configService.setConfig(key, value, description, req.user.id);
        res.status(200).json({ message: "System configuration updated", data: config });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getSystemConfigs = async (req, res) => {
    try {
        const configs = await SystemConfig.find({}).populate("updatedBy", "firstName lastName");
        res.status(200).json({ data: configs });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// ─── NEW ADMIN ROUTES ─────────────────────────────────────────────────────

const getDriversList = async (req, res) => {
    try {
        const { page = 1, limit = 20, search } = req.query;
        const filters = search ? { $or: [{ firstName: new RegExp(search, "i") }, { lastName: new RegExp(search, "i") }, { phone: new RegExp(search, "i") }] } : {};
        const result = await adminService.getDrivers(filters, parseInt(page), parseInt(limit));
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getDriverDetails = async (req, res) => {
    try {
        const driver = await userService.getUserById(req.params.id);
        const DriverProfile = require("../models/DriverProfile");
        const profile = await DriverProfile.findOne({ driverId: req.params.id });
        res.status(200).json({ user: driver, profile });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateUserStatus = async (req, res) => {
    try {
        const { isActive } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
        res.status(200).json({ message: "User status updated", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const verifyUser = async (req, res) => {
    try {
        const user = await User.findByIdAndUpdate(req.params.id, { isVerified: true }, { new: true });
        res.status(200).json({ message: "User verified manually", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateKYC = async (req, res) => {
    try {
        const { kycLevel } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { kycLevel }, { new: true });
        res.status(200).json({ message: "KYC level updated", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getAgentsRegistrations = async (req, res) => {
    try {
        const stats = await adminService.getAgentsStats();
        res.status(200).json({ data: stats });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const approveFine = async (req, res) => {
    try {
        const { id, status } = req.body; // id = fine _id, status = 'approved' or 'rejected'
        const Fine = require("../models/Fine");
        const fine = await Fine.findByIdAndUpdate(id, {
            status,
            reviewedBy: req.user.id,
            reviewedAt: Date.now()
        }, { new: true });

        if (!fine) return res.status(404).json({ message: "Fine not found" });

        // If approved, you might want to automate something, 
        // but user only asked for approving endpoint.

        res.status(200).json({ message: `Fine ${status}`, data: fine });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getUsersList,
    getDriversList,
    getDriverDetails,
    updateUserStatus,
    verifyUser,
    updateKYC,
    deleteUserAccount,
    getStats,
    getAgentsRegistrations,
    approveFine,
    banUserAccount,
    unbanUserAccount,
    updateSystemConfig,
    getSystemConfigs,
};
