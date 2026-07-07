const Reserve = require("../models/Reserve");
const auditService = require("./auditService");

/**
 * Initialize a reserve if it doesn't exist
 */
const initReserve = async (type, targetBalance = 0) => {
    let reserve = await Reserve.findOne({ type });
    if (!reserve) {
        reserve = await Reserve.create({ type, targetBalance });
    }
    return reserve;
};

/**
 * Get reserve balances
 */
const getReserves = async () => {
    const reserves = await Reserve.find({});
    return reserves;
};

/**
 * Update reserve balance (admin operation)
 */
const updateReserve = async (type, amount, direction, reason, adminId) => {
    if (amount <= 0) throw new Error("Amount must be positive");
    if (!["in", "out"].includes(direction)) throw new Error("Direction must be 'in' or 'out'");

    const reserve = await initReserve(type);

    if (direction === "out" && reserve.balance < amount) {
        throw new Error(`Insufficient funds in ${type} reserve. Available: ${reserve.balance}`);
    }

    if (direction === "in") {
        reserve.balance += amount;
        reserve.lastTopUpAt = new Date();
    } else {
        reserve.balance -= amount;
    }

    reserve.transactions.push({
        amount,
        direction,
        reason,
        timestamp: new Date(),
    });

    await reserve.save();

    await auditService.log({
        actorId: adminId,
        actorRole: "admin",
        action: "admin_reserve_update",
        targetType: "Reserve",
        targetId: reserve._id,
        metadata: { type, amount, direction, reason, newBalance: reserve.balance },
    });

    return reserve;
};

/**
 * Set target balance for a reserve
 */
const setTargetBalance = async (type, targetBalance, adminId) => {
    const reserve = await initReserve(type);
    const oldTarget = reserve.targetBalance;
    reserve.targetBalance = targetBalance;
    await reserve.save();

    await auditService.log({
        actorId: adminId,
        actorRole: "admin",
        action: "admin_reserve_update",
        targetType: "Reserve",
        targetId: reserve._id,
        metadata: { type, update: "target_balance", oldTarget, newTarget: targetBalance },
    });

    return reserve;
};

module.exports = {
    initReserve,
    getReserves,
    updateReserve,
    setTargetBalance,
};
