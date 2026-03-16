const userService = require("../services/userService");
const uploadService = require("../services/uploadService");

const getUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await userService.getUsers({}, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getUser = async (req, res) => {
    try {
        const user = await userService.getUserById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getMe = async (req, res) => {
    try {
        const user = await userService.getUserById(req.user.id);
        res.status(200).json({ data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateMe = async (req, res) => {
    try {
        const { firstName, lastName, phone } = req.body;
        // Don't allow updating sensitive fields here directly
        const user = await userService.updateUser(req.user.id, { firstName, lastName, phone });
        res.status(200).json({ message: "Profile updated", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const uploadAvatar = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "Avatar file required" });

        // Multer-storage-cloudinary directly processes and returns the URL in req.file.path
        const avatarUrl = req.file.path;

        // Update User profile with just the avatar link (pure URL)
        const user = await userService.updateUser(req.user.id, { avatarUrl });

        res.status(200).json({ message: "Avatar uploaded successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const deleteAccount = async (req, res) => {
    try {
        await userService.deleteUser(req.user.id);
        res.status(200).json({ message: "Account deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const assignRole = async (req, res) => {
    try {
        const { roleId } = req.body;
        const user = await userService.assignRole(req.params.id, roleId);

        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ message: "Role assigned successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getUsers,
    getUser,
    getMe,
    updateMe,
    uploadAvatar,
    deleteAccount,
    assignRole,
};
