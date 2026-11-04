const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const Fine = require("../models/Fine");
const { sendSMS } = require("./smsService");
const User = require("../models/User");
const Ride = require("../models/Ride");
const configService = require("./configService");
const mongoose = require("mongoose");

/**
 * Get or create wallet for a user (driver/agent)
 */
const getOrCreateWallet = async (driverId) => {
    let wallet = await Wallet.findOne({ driverId });
    if (!wallet) {
        wallet = await Wallet.create({ driverId, balance: 0 });
    }
    return wallet;
};

/**
 * Get wallet balance
 */
const getBalance = async (driverId) => {
    const wallet = await getOrCreateWallet(driverId);
    return wallet.balance;
};

/**
 * Get a comprehensive wallet summary with all computed amounts:
 * - balance (current wallet balance)
 * - today: income, expenses, net, per-type breakdown
 * - fines: total fines, pending, approved/unpaid, paid, remaining
 * - allTime: total income, total expenses, total fees paid
 * - thisWeek / thisMonth snapshots
 * - recentTransactions (last 20)
 */
const getWalletSummary = async (driverId) => {
    const wallet = await getOrCreateWallet(driverId);
    const objectId = typeof driverId === "string"
        ? mongoose.Types.ObjectId.createFromHexString(driverId)
        : driverId;

    // ── Time boundaries ─────────────────────────────────────────────
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── Parallel queries ────────────────────────────────────────────
    const [
        todayBreakdown,
        weekAgg,
        monthAgg,
        allTimeAgg,
        fines,
        fineAgg,
        recentTransactions,
    ] = await Promise.all([
        // Today's transactions grouped by type
        Transaction.aggregate([
            {
                $match: {
                    driverId: objectId,
                    status: "successful",
                    createdAt: { $gte: startOfToday, $lte: endOfToday },
                },
            },
            {
                $group: {
                    _id: "$type",
                    total: { $sum: "$amount" },
                    count: { $sum: 1 },
                    totalFees: { $sum: "$feeAmount" },
                },
            },
        ]),

        // This week totals
        Transaction.aggregate([
            {
                $match: {
                    driverId: objectId,
                    status: "successful",
                    createdAt: { $gte: startOfWeek },
                },
            },
            {
                $group: {
                    _id: null,
                    income: {
                        $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
                    },
                    expenses: {
                        $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] },
                    },
                    totalFees: { $sum: "$feeAmount" },
                    count: { $sum: 1 },
                },
            },
        ]),

        // This month totals
        Transaction.aggregate([
            {
                $match: {
                    driverId: objectId,
                    status: "successful",
                    createdAt: { $gte: startOfMonth },
                },
            },
            {
                $group: {
                    _id: null,
                    income: {
                        $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
                    },
                    expenses: {
                        $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] },
                    },
                    totalFees: { $sum: "$feeAmount" },
                    count: { $sum: 1 },
                },
            },
        ]),

        // All-time totals
        Transaction.aggregate([
            {
                $match: {
                    driverId: objectId,
                    status: "successful",
                },
            },
            {
                $group: {
                    _id: null,
                    income: {
                        $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
                    },
                    expenses: {
                        $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] },
                    },
                    totalFees: { $sum: "$feeAmount" },
                    count: { $sum: 1 },
                },
            },
        ]),

        // All fines for this driver
        Fine.find({ driverId: objectId }).sort({ createdAt: -1 }),

        // Fines aggregation by status
        Fine.aggregate([
            { $match: { driverId: objectId } },
            {
                $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                    totalAmount: { $sum: "$amount" },
                    totalWithInterest: { $sum: "$totalAmountWithInterest" },
                    totalPaid: { $sum: "$paidAmount" },
                },
            },
        ]),

        // Recent transactions
        Transaction.find({ driverId: objectId })
            .sort({ createdAt: -1 })
            .limit(20),
    ]);

    // ── Build today breakdown ───────────────────────────────────────
    let todayIncome = 0;
    let todayExpenses = 0;
    let todayFees = 0;
    const todayByType = {};

    for (const row of todayBreakdown) {
        todayByType[row._id] = {
            total: row.total,
            count: row.count,
            fees: row.totalFees,
        };
        if (row.total > 0) {
            todayIncome += row.total;
        } else {
            todayExpenses += Math.abs(row.total);
        }
        todayFees += row.totalFees;
    }

    // ── Build fines summary ─────────────────────────────────────────
    let finesTotalAmount = 0;
    let finesTotalWithInterest = 0;
    let finesTotalPaid = 0;
    const finesByStatus = {};

    for (const row of fineAgg) {
        finesByStatus[row._id] = {
            count: row.count,
            totalAmount: row.totalAmount,
            totalWithInterest: row.totalWithInterest,
            totalPaid: row.totalPaid,
        };
        finesTotalAmount += row.totalAmount;
        finesTotalWithInterest += row.totalWithInterest;
        finesTotalPaid += row.totalPaid;
    }

    const finesRemaining = finesTotalWithInterest - finesTotalPaid;

    // ── Helpers ─────────────────────────────────────────────────────
    const weekData = weekAgg[0] || { income: 0, expenses: 0, totalFees: 0, count: 0 };
    const monthData = monthAgg[0] || { income: 0, expenses: 0, totalFees: 0, count: 0 };
    const allTimeData = allTimeAgg[0] || { income: 0, expenses: 0, totalFees: 0, count: 0 };

    return {
        // ── Core balance ────────────────────────────────────────────
        balance: wallet.balance,
        heldBalance: wallet.heldBalance || 0,
        fuelCredits: wallet.fuelCredits || 0,

        // ── Today ───────────────────────────────────────────────────
        today: {
            income: todayIncome,
            expenses: todayExpenses,
            net: todayIncome - todayExpenses,
            fees: todayFees,
            breakdown: todayByType,
        },

        // ── This week ───────────────────────────────────────────────
        thisWeek: {
            income: weekData.income,
            expenses: weekData.expenses,
            net: weekData.income - weekData.expenses,
            fees: weekData.totalFees,
            transactionCount: weekData.count,
        },

        // ── This month ──────────────────────────────────────────────
        thisMonth: {
            income: monthData.income,
            expenses: monthData.expenses,
            net: monthData.income - monthData.expenses,
            fees: monthData.totalFees,
            transactionCount: monthData.count,
        },

        // ── All time ────────────────────────────────────────────────
        allTime: {
            totalIncome: allTimeData.income,
            totalExpenses: allTimeData.expenses,
            totalFees: allTimeData.totalFees,
            totalTransactions: allTimeData.count,
        },

        // ── Fines ───────────────────────────────────────────────────
        fines: {
            totalFines: fines.length,
            totalAmount: finesTotalAmount,
            totalWithInterest: finesTotalWithInterest,
            totalPaid: finesTotalPaid,
            remaining: finesRemaining,
            byStatus: finesByStatus,
            list: fines,
        },

        // ── Recent transactions ─────────────────────────────────────
        recentTransactions,
    };
};

/**
 * Credit wallet (add funds) — no automatic fee deduction
 */
const creditWallet = async (driverId, amount, type, meta = {}) => {
    if (amount <= 0) throw new Error("Credit amount must be positive");

    const wallet = await getOrCreateWallet(driverId);
    wallet.balance += amount;
    await wallet.save();

    await Transaction.create({
        driverId,
        agentId: meta.agentId || null,
        rideId: meta.rideId || null,
        amount,
        feeAmount: meta.feeAmount || 0,
        type,
        status: "successful",
        reference: meta.reference || null,
        description: meta.description || null,
        paypackRef: meta.paypackRef || null,
    });

    // Money in pays off commission still owed from cash rides first.
    try {
        if (await collectOwedCommission(driverId) > 0) return getOrCreateWallet(driverId);
    } catch (error) {
        console.error("Owed commission collection failed:", error.message);
    }
    return wallet;
};

/**
 * Debit wallet (deduct funds) — no automatic fee deduction
 */
const debitWallet = async (driverId, amount, type, meta = {}) => {
    if (amount <= 0) throw new Error("Debit amount must be positive");

    const wallet = await getOrCreateWallet(driverId);
    if (wallet.balance < amount) {
        throw new Error(`Insufficient wallet balance. Required: ${amount} RWF, Available: ${wallet.balance} RWF`);
    }

    wallet.balance -= amount;
    await wallet.save();

    await Transaction.create({
        driverId,
        agentId: meta.agentId || null,
        rideId: meta.rideId || null,
        amount: -amount,
        feeAmount: meta.feeAmount || 0,
        type,
        status: "successful",
        reference: meta.reference || null,
        description: meta.description || null,
        paypackRef: meta.paypackRef || null,
    });

    return wallet;
};

/**
 * Idempotently settle a confirmed, non-ride Paypack cash-in.
 * The pending transaction status and wallet credit change in one MongoDB
 * transaction so webhook retries cannot credit the wallet twice.
 */
const settleCashInTransaction = async (transactionId, payload) => {
    let credited = false;
    let wallet = null;
    await mongoose.connection.transaction(async (session) => {
        const tx = await Transaction.findOneAndUpdate(
            { _id: transactionId, type: "cash_in", status: "pending", rideId: null },
            { $set: { status: "successful", paypackEvent: payload } },
            { returnDocument: "after", session },
        );
        if (!tx) return;
        wallet = await Wallet.findOneAndUpdate(
            { driverId: tx.driverId },
            { $inc: { balance: Math.abs(tx.amount) }, $setOnInsert: { driverId: tx.driverId } },
            { returnDocument: "after", upsert: true, session, setDefaultsOnInsert: true },
        );
        if (await collectOwedCommission(tx.driverId, session) > 0) wallet = await Wallet.findOne({ driverId: tx.driverId }).session(session);
        credited = true;
    });
    return { credited, wallet };
};

/**
 * Calculate ride commission from system settings
 * ride_commission_percentage stored as percentage (e.g. 10 means 10%)
 */
const calculateCommission = async (fare) => {
    const commissionPercentage = await configService.getConfig("ride_commission_percentage", 10);
    const commission = Math.round(fare * (commissionPercentage / 100));
    const driverEarning = fare - commission;
    return { commission, driverEarning, commissionRate: commissionPercentage / 100 };
};

/**
 * The commission a ride settles with: the amount stored on the ride (what the
 * driver was shown when they accepted), or today's rate when the ride has none
 * or the fare being settled differs from the ride's fare.
 */
const rideCommission = async (ride, fare = Number(ride?.fare) || 0) => {
    const shown = Number(ride?.commissionAmount);
    if (ride && Number(ride.fare) === fare && Number.isFinite(shown) && shown >= 0 && shown <= fare) {
        return { commission: shown, driverEarning: fare - shown };
    }
    const { commission, driverEarning } = await calculateCommission(fare);
    return { commission, driverEarning };
};

const inTransaction = (session, work) => (session ? work(session) : mongoose.connection.transaction(work));

/**
 * Collect commission the driver still owes (cash rides finished while the
 * wallet could not cover it) from their balance, oldest first. The balance
 * never goes below zero: whatever is not covered stays pending for the next
 * money in. Returns the amount collected.
 */
const collectOwedCommission = async (driverId, session) => {
    let collected = 0;
    await inTransaction(session, async (s) => {
        collected = 0;
        const owed = await Transaction.find({ driverId, type: "platform_commission", status: "pending" }).sort({ createdAt: 1, _id: 1 }).session(s);
        for (const row of owed) {
            const wallet = await Wallet.findOne({ driverId }).session(s);
            const due = Math.abs(row.amount);
            const take = Math.min(due, Math.max(0, Math.floor(wallet?.balance || 0)));
            if (take <= 0) break;
            // Claim the row before moving money: a concurrent collector conflicts here and retries.
            const claimed = await Transaction.findOneAndUpdate(
                { _id: row._id, status: "pending", amount: row.amount },
                take === due
                    ? { $set: { status: "successful", description: `${row.description || "Ride commission"} (collected from wallet)` } }
                    : { $set: { amount: -(due - take) } },
                { returnDocument: "after", session: s },
            );
            if (!claimed) continue;
            const debited = await Wallet.findOneAndUpdate({ driverId, balance: { $gte: take } }, { $inc: { balance: -take } }, { returnDocument: "after", session: s });
            if (!debited) throw new Error("Wallet balance changed while collecting commission.");
            if (take < due) {
                await Transaction.create([{
                    driverId, rideId: row.rideId, amount: -take, type: "platform_commission", status: "successful",
                    description: `Part of the commission owed on ride ${row.rideId} (collected from wallet)`,
                }], { session: s });
            }
            collected += take;
        }
    });
    return collected;
};

/**
 * Cash ride: the driver already holds the whole fare, so MOTA's commission is
 * charged to their wallet. It is recorded as owed and collected straight away
 * as far as the balance allows. Must run inside the caller's transaction.
 */
const chargeCashRideCommission = async ({ driverId, rideId, fare, commission }, session) => {
    if (!(commission > 0)) return 0;
    await Transaction.create([{
        driverId, rideId, amount: -commission, type: "platform_commission", status: "pending",
        description: `MOTA commission on cash ride ${rideId} (fare ${fare} RWF collected in cash)`,
    }], { session });
    return collectOwedCommission(driverId, session);
};

/**
 * Paid ride (wallet or MoMo): the fare goes in, the commission goes out, as
 * ledger rows that add up to the balance change (fare - commission). Pass
 * `fareRecorded` when a payment row for the fare already exists (MoMo).
 * Must run inside the caller's transaction.
 */
const creditRideEarning = async ({ driverId, rideId, fare, commission, fareRecorded = false }, session) => {
    await Wallet.findOneAndUpdate({ driverId }, { $inc: { balance: fare - commission } }, { upsert: true, returnDocument: "after", session, setDefaultsOnInsert: true });
    const rows = [];
    if (!fareRecorded) rows.push({ driverId, rideId, amount: fare, feeAmount: commission, type: "ride_payment", status: "successful", description: `Ride fare (${commission} RWF MOTA commission)` });
    if (commission > 0) rows.push({ driverId, rideId, amount: -commission, type: "platform_commission", status: "successful", description: `MOTA commission on ride ${rideId}` });
    if (rows.length) await Transaction.create(rows, { session, ordered: true });
    await collectOwedCommission(driverId, session);
    return Wallet.findOne({ driverId }).session(session);
};

/**
 * Idempotently settle a confirmed Paypack ride payment (app MoMo rides, logged
 * rides, USSD). The pending payment row becomes the "fare in" row, the
 * driver is credited fare minus commission, and the commission is recorded,
 * all in one transaction so webhook retries and status polling are no-ops.
 */
const settleRidePaymentTransaction = async (transactionId, payload) => {
    let result = { credited: false };
    await mongoose.connection.transaction(async (session) => {
        result = { credited: false };
        const tx = await Transaction.findOneAndUpdate(
            { _id: transactionId, status: "pending", type: { $in: ["cash_in", "ride_payment"] } },
            { $set: { status: "successful", paypackEvent: payload } },
            { returnDocument: "after", session },
        );
        if (!tx) return;
        const fare = Math.abs(tx.amount);
        const ride = tx.rideId ? await Ride.findById(tx.rideId).session(session) : null;
        const { commission, driverEarning } = await rideCommission(ride, fare);
        await Transaction.updateOne({ _id: tx._id }, { $set: { feeAmount: commission } }, { session });
        const wallet = await creditRideEarning({ driverId: tx.driverId, rideId: tx.rideId, fare, commission, fareRecorded: true }, session);
        if (ride) {
            ride.paymentStatus = "successful";
            ride.commissionAmount = commission;
            ride.driverEarning = driverEarning;
            await ride.save({ session });
        }
        result = { credited: true, tx, wallet, fare, commission, driverEarning };
    });
    return result;
};

/**
 * Credit driver wallet after ride payment (with commission deduction)
 */
const creditRidePayment = async (driverId, rideId, fare) => {
    const { commission, driverEarning } = await calculateCommission(fare);

    // Credit driver with earnings (after commission)
    const wallet = await creditWallet(driverId, driverEarning, "ride_payment", {
        rideId,
        description: `Ride payment. Fare: ${fare} RWF. Commission: ${commission} RWF.`,
    });

    // Record platform commission transaction
    if (commission > 0) {
        await Transaction.create({
            driverId,
            rideId,
            amount: commission,
            type: "platform_commission",
            status: "successful",
            description: `Platform commission from ride. ${commission} RWF.`,
        });
    }

    // SMS to driver
    const user = await User.findById(driverId);
    if (user) {
        await sendSMS(
            user.phone,
            `MOTA Payment\nRide payment received.\nAmount: ${driverEarning} RWF\nWallet Balance: ${wallet.balance} RWF`,
            "ride_confirmation"
        );
    }

    return { wallet, driverEarning, commission };
};

/**
 * Agent cash-in: credit driver wallet with physical cash via agent
 * Uses agent_cash_in_fee_percentage from settings
 */
const agentCashIn = async (agentId, driverId, amount) => {
    const feePercentage = await configService.getConfig("agent_cash_in_fee_percentage", 0);
    const fee = Math.round(amount * (feePercentage / 100));
    const netAmount = amount - fee;

    const wallet = await creditWallet(driverId, netAmount, "agent_cash_in", {
        agentId,
        feeAmount: fee,
        description: `Agent cash-in. Amount: ${amount} RWF${fee > 0 ? `. Fee: ${fee} RWF` : ""}.`,
    });

    const user = await User.findById(driverId);
    if (user) {
        await sendSMS(
            user.phone,
            `MOTA Wallet\nCash deposit confirmed.\nAmount: ${netAmount} RWF\nWallet Balance: ${wallet.balance} RWF`,
            "cash_in"
        );
    }

    return wallet;
};

/**
 * Cash-out with fee deduction from settings
 * Uses cash_out_fee_percentage from settings
 */
const processCashOut = async (driverId, amount) => {
    const feePercentage = await configService.getConfig("cash_out_fee_percentage", 2);
    const fee = Math.round(amount * (feePercentage / 100));
    const totalDeduction = amount + fee;

    const wallet = await getOrCreateWallet(driverId);
    if (wallet.balance < totalDeduction) {
        throw new Error(`Insufficient balance. Need ${totalDeduction} RWF (incl. ${feePercentage}% fee). Available: ${wallet.balance} RWF`);
    }

    wallet.balance -= totalDeduction;
    await wallet.save();

    // Record cash-out transaction
    const tx = await Transaction.create({
        driverId,
        amount: -amount,
        type: "cash_out",
        status: "successful",
        description: `Cash-out withdrawal. Amount: ${amount} RWF.`,
    });

    // Record fee transaction
    if (fee > 0) {
        await Transaction.create({
            driverId,
            amount: -fee,
            feeAmount: fee,
            type: "cash_out_fee",
            status: "successful",
            description: `Cash-out fee (${feePercentage}%). Fee: ${fee} RWF.`,
        });
    }

    return { wallet, fee, totalDeduction, transactionId: tx._id };
};

/**
 * Admin credit: manually send money to driver wallet
 */
const adminCreditWallet = async (adminId, driverId, amount, reason) => {
    const wallet = await creditWallet(driverId, amount, "admin_credit", {
        description: reason || "Admin credit",
    });

    const user = await User.findById(driverId);
    if (user) {
        await sendSMS(
            user.phone,
            `MOTA Notification\nYou have received a credit of ${amount} RWF.\nReason: ${reason || "Admin credit"}\nWallet Balance: ${wallet.balance} RWF`,
            "admin_credit"
        );
    }

    return wallet;
};

/**
 * Pay fine: deduct from wallet
 */
const payFine = async (driverId, fineId, amount) => {
    const wallet = await debitWallet(driverId, amount, "fine_payment", {
        description: `Fine payment. Fine ID: ${fineId}`,
    });

    const user = await User.findById(driverId);
    if (user) {
        await sendSMS(
            user.phone,
            `MOTA Fines\nFine payment of ${amount} RWF processed.\nWallet Balance: ${wallet.balance} RWF`,
            "fine_payment"
        );
    }

    return wallet;
};

/**
 * Referral reward: credit wallet with referral bonus
 * Amount comes from system settings
 */
const rewardReferral = async (driverId, amount) => {
    // If amount not passed, get from settings
    const rewardAmount = amount || await configService.getConfig("referral_reward_amount", 5000);

    const wallet = await creditWallet(driverId, rewardAmount, "referral_reward", {
        description: `Referral reward. Amount: ${rewardAmount} RWF`,
    });

    const user = await User.findById(driverId);
    if (user) {
        await sendSMS(
            user.phone,
            `MOTA Referral\nCongratulations! You earned a referral reward of ${rewardAmount} RWF.\nWallet Balance: ${wallet.balance} RWF`,
            "referral_reward"
        );
    }

    return wallet;
};

module.exports = {
    getOrCreateWallet,
    getBalance,
    getWalletSummary,
    creditWallet,
    debitWallet,
    settleCashInTransaction,
    calculateCommission,
    rideCommission,
    collectOwedCommission,
    chargeCashRideCommission,
    creditRideEarning,
    settleRidePaymentTransaction,
    creditRidePayment,
    agentCashIn,
    processCashOut,
    adminCreditWallet,
    payFine,
    rewardReferral,
    COMMISSION_RATE: 0.10, // backward compat reference
};
