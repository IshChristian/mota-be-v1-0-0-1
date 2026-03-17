const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const { sendSMS } = require("./smsService");
const User = require("../models/User");
const configService = require("./configService");

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
        status: "completed",
        reference: meta.reference || null,
        description: meta.description || null,
        paypackRef: meta.paypackRef || null,
    });

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
        status: "completed",
        reference: meta.reference || null,
        description: meta.description || null,
        paypackRef: meta.paypackRef || null,
    });

    return wallet;
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
            status: "completed",
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
    await Transaction.create({
        driverId,
        amount: -amount,
        type: "cash_out",
        status: "completed",
        description: `Cash-out withdrawal. Amount: ${amount} RWF.`,
    });

    // Record fee transaction
    if (fee > 0) {
        await Transaction.create({
            driverId,
            amount: -fee,
            feeAmount: fee,
            type: "cash_out_fee",
            status: "completed",
            description: `Cash-out fee (${feePercentage}%). Fee: ${fee} RWF.`,
        });
    }

    return { wallet, fee, totalDeduction };
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
    creditWallet,
    debitWallet,
    calculateCommission,
    creditRidePayment,
    agentCashIn,
    processCashOut,
    adminCreditWallet,
    payFine,
    rewardReferral,
    COMMISSION_RATE: 0.10, // backward compat reference
};
