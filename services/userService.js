const User = require("../models/User");

const getUsers = async (filters, page = 1, limit = 20) => {
    const skip = (page - 1) * limit;
    const users = await User.find(filters)
        .populate("roleId", "name permissions")
        .populate("avatarId", "url format")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

    const total = await User.countDocuments(filters);

    return {
        data: users,
        page,
        limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit),
    };
};

const getUserById = async (id) => {
    return await User.findById(id)
        .populate("roleId", "name permissions")
        .populate("avatarId", "url format");
};

const updateUser = async (id, updateData) => {
    return await User.findByIdAndUpdate(id, updateData, { new: true })
        .populate("roleId", "name permissions")
        .populate("avatarId", "url format");
};

const assignRole = async (userId, roleId) => {
    return await User.findByIdAndUpdate(userId, { roleId }, { new: true });
};

const deleteUser = async (id) => {
    // Basic soft delete or hard delete. Hard deleting for now to match the user request of deleting an account.
    return await User.findByIdAndDelete(id);
};

module.exports = {
    getUsers,
    getUserById,
    updateUser,
    assignRole,
    deleteUser,
};
