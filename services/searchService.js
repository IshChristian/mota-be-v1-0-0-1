const User = require("../models/User");
const Ride = require("../models/Ride");
const Transaction = require("../models/Transaction");

const buildSearchRegex = (query) => {
    // Basic case-insensitive search
    return new RegExp(query, "i");
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
const universalSearch = async (query) => {
    const regex = buildSearchRegex(query);
    
    // Quick limit for universal drop-down type search
    const users = await User.find({
        $or: [{ firstName: regex }, { lastName: regex }, { phone: regex }]
    }).select("firstName lastName phone role _id").limit(10);
    
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
    
    const transactions = await Transaction.find(transactionFilter).limit(10);
    
    return {
        users,
        transactions,
        // Depending on ride schema, they might search by pickup/dropoff
    };
};

module.exports = {
    searchUsers,
    universalSearch,
};
