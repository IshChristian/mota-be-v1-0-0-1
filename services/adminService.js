const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Ride = require("../models/Ride");

const getSystemStats = async () => {
    const totalUsers = await User.countDocuments();
    const totalDrivers = await User.countDocuments({ role: "driver" });
    const totalAgents = await User.countDocuments({ role: "agent" });
    const activeRides = await Ride.countDocuments({ paymentStatus: "pending" });
    const completedRides = await Ride.countDocuments({ paymentStatus: "successful" });

    // Calculate total revenue (commissions)
    const result = await Ride.aggregate([
        { $match: { paymentStatus: "successful" } },
        { $group: { _id: null, totalCommission: { $sum: "$commissionAmount" } } }
    ]);
    const totalRevenue = result.length > 0 ? result[0].totalCommission : 0;

    return {
        totalUsers,
        totalDrivers,
        totalAgents,
        activeRides,
        completedRides,
        totalRevenue,
    };
};

const getDrivers = async (filters, page = 1, limit = 20) => {
    const skip = (page - 1) * limit;
    const query = { role: "driver", ...filters };

    const drivers = await User.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

    const total = await User.countDocuments(query);

    return {
        data: drivers,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    };
};

const getAgentsStats = async () => {
    // Return agents and how many drivers they referred
    const agents = await User.find({ role: "agent" });
    const Referral = require("../models/Referral");

    const stats = await Promise.all(agents.map(async (agent) => {
        const count = await Referral.countDocuments({ referrerId: agent._id });
        return {
            id: agent._id,
            name: `${agent.firstName} ${agent.lastName}`,
            phone: agent.phone,
            referralCount: count
        };
    }));

    return stats;
};

const banUser = async (userId) => {
    return await User.findByIdAndUpdate(userId, { isActive: false }, { new: true });
};

const unbanUser = async (userId) => {
    return await User.findByIdAndUpdate(userId, { isActive: true }, { new: true });
};

module.exports = {
    getSystemStats,
    getDrivers,
    getAgentsStats,
    banUser,
    unbanUser,
};
