const User = require("../models/User");
const Ride = require("../models/Ride");
const Transaction = require("../models/Transaction");

const buildSearchRegex = (query) => {
    // Basic case-insensitive search
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
};

const searchUsers = async (query, page = 1, limit = 20) => {
    const regex = buildSearchRegex(query);
    const filter = {
        $or: [
            { firstName: regex },
            { lastName: regex },
            { phone: regex },
            { email: regex },
        ]
    };
    
    const skip = (page - 1) * limit;
    const users = await User.find(filter)
        .select("-password -otpToken")
        .populate("roleId", "name permissions")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
        
    const total = await User.countDocuments(filter);
    
    return {
        data: users,
        page,
        limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit),
    };
};

// Universal search covering multiple collections and combining them
const universalSearch = async (query, actor) => {
    const regex = buildSearchRegex(query);
    const role = actor.role;
    const selfService = !["admin", "superadmin"].includes(role);
    if (selfService && !["client", "passenger", "driver"].includes(role)) return [];
    const scopedRide = role === "driver" ? { driverId: actor._id } : { passengerId: actor._id };
    const scopedTransaction = { $or: [{ userId: actor._id }, { driverId: actor._id }] };
    const users = selfService ? [] : await User.find({
        $or: [{ firstName: regex }, { lastName: regex }, { phone: regex }]
    }).select("firstName lastName phone role _id").limit(10).lean();
    
    // Try to parse query into number for fare/amount search
    const queryNumber = parseInt(query);
    const transactionFilter = {
        $or: [
            { type: regex },
            { status: regex },
            { description: regex }
        ]
    };
    if (!isNaN(queryNumber)) {
        transactionFilter.$or.push({ amount: queryNumber });
    }
    
    const rideFilter = { $or: [
        { "pickup.name": regex }, { "pickup.address": regex },
        { "destination.name": regex }, { "destination.address": regex },
        { pickupLocation: regex }, { dropoffLocation: regex }, { rideStatus: regex }
    ] };
    const [rides, transactions] = await Promise.all([
        Ride.find(selfService ? { $and: [scopedRide, rideFilter] } : rideFilter)
            .select("pickup destination pickupLocation dropoffLocation rideStatus createdAt")
            .sort({ createdAt: -1 }).limit(20).lean(),
        Transaction.find(selfService ? { $and: [scopedTransaction, transactionFilter] } : transactionFilter)
            .select("type status description amount createdAt reference")
            .sort({ createdAt: -1 }).limit(20).lean()
    ]);
    return [
        ...rides.map(ride => ({ id: ride._id, type: "ride", title: ride.destination?.name || ride.dropoffLocation || "Ride", description: ride.rideStatus || "Ride", createdAt: ride.createdAt })),
        ...transactions.map(tx => ({ id: tx._id, type: "transaction", title: tx.description || tx.type, description: `${tx.amount} RWF · ${tx.status}`, createdAt: tx.createdAt })),
        ...users.map(user => ({ id: user._id, type: "user", title: `${user.firstName} ${user.lastName}`, description: user.role }))
    ];
};

module.exports = {
    searchUsers,
    universalSearch,
};
