const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Ride = require("../models/Ride");

const ACTIVE_RIDE_STATUSES = ["requested", "searching", "accepted", "approaching", "arrived", "start_requested", "in_progress", "stop_requested", "awaiting_payment"];

const getSystemStats = async () => {
    const totalUsers = await User.countDocuments();
    const totalDrivers = await User.countDocuments({ role: "driver" });
    const totalAgents = await User.countDocuments({ role: "agent" });
    // By trip state, so cancelled/expired unpaid rides aren't counted as active (matches the operations queue).
    const activeRides = await Ride.countDocuments({ rideStatus: { $in: ACTIVE_RIDE_STATUSES } });
    const completedRides = await Ride.countDocuments({ rideStatus: "completed" });

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
    return await User.findByIdAndUpdate(userId, { isActive: false }, { returnDocument: "after" });
};

const unbanUser = async (userId) => {
    return await User.findByIdAndUpdate(userId, { isActive: true }, { returnDocument: "after" });
};

module.exports = {
    getSystemStats,
    getDrivers,
    getAgentsStats,
    banUser,
    unbanUser,
};
