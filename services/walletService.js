const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const { sendSMS } = require("./smsService");
const User = require("../models/User");
const configService = require("./configService");

const DEFAULT_COMMISSION_RATE = 0.10; // 10%
const DEFAULT_TRANSACTION_FEE_RATE = 0.01; // 1%

/**
 * Get or create wallet for a driver
 * @param {string} driverId
 * @returns {Object} wallet document
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
 * @param {string} driverId
 * @returns {number} balance
 */
const getBalance = async (driverId) => {
    const wallet = await getOrCreateWallet(driverId);
    return wallet.balance;
};

/**
 * Credit wallet (add funds)
 * @param {string} driverId
 * @param {number} amount
 * @param {string} type - transaction type
 * @param {Object} meta - {rideId, agentId, reference, description, paypackRef}
 */
const creditWallet = async (driverId, amount, type, meta = {}) => {
    if (amount <= 0) throw new Error("Credit amount must be positive");

    const feeRate = await configService.getConfig("transaction_fee_rate", DEFAULT_TRANSACTION_FEE_RATE);
    const fee = Math.round(amount * feeRate);
    const netAmount = amount - fee;

    const wallet = await getOrCreateWallet(driverId);
    wallet.balance += netAmount;
    await wallet.save();

    await Transaction.create({
        driverId,
        agentId: meta.agentId || null,
        rideId: meta.rideId || null,
        amount: netAmount,
        type,
        status: "completed",
        reference: meta.reference || null,
        description: meta.description || null,
        paypackRef: meta.paypackRef || null,
    });

    if (fee > 0) {
        await Transaction.create({
            driverId,
            amount: fee,
            type: "transaction_fee",
            status: "completed",
            description: `MOTA ${feeRate * 100}% Transaction Fee (Credit Deduction)`,
            rideId: meta.rideId || null,
        });
    }

    return wallet;
};

/**
 * Debit wallet (deduct funds)
 * @param {string} driverId
 * @param {number} amount
 * @param {string} type
 * @param {Object} meta
 */
const debitWallet = async (driverId, amount, type, meta = {}) => {
    if (amount <= 0) throw new Error("Debit amount must be positive");

    const feeRate = await configService.getConfig("transaction_fee_rate", DEFAULT_TRANSACTION_FEE_RATE);
    const fee = Math.round(amount * feeRate);
    const totalDeduction = amount + fee;

    const wallet = await getOrCreateWallet(driverId);
    if (wallet.balance < totalDeduction) {
        throw new Error(`Insufficient wallet balance. Require ${totalDeduction} RWF (incl. ${feeRate * 100}% fee)`);
    }

    wallet.balance -= totalDeduction;
    await wallet.save();

    await Transaction.create({
        driverId,
        agentId: meta.agentId || null,
        rideId: meta.rideId || null,
        amount: -amount,
        type,
        status: "completed",
        reference: meta.reference || null,
        description: meta.description || null,
        paypackRef: meta.paypackRef || null,
    });

    if (fee > 0) {
        await Transaction.create({
            driverId,
            amount: -fee,
            type: "transaction_fee",
            status: "completed",
            description: `MOTA ${feeRate * 100}% Transaction Fee (Debit Fee)`,
        });
    }

    return wallet;
};

/**
 * Calculate commission and driver earning
 * @param {number} fare
 * @returns {Promise<{ commission, driverEarning }>}
 */
const calculateCommission = async (fare) => {
    const commissionRate = await configService.getConfig("ride_commission_rate", DEFAULT_COMMISSION_RATE);
    const commission = Math.round(fare * commissionRate);
    const driverEarning = fare - commission;
    return { commission, driverEarning };
};

/**
 * Credit driver wallet after ride payment
 * @param {string} driverId
 * @param {string} rideId
 * @param {number} fare
 */
const creditRidePayment = async (driverId, rideId, fare) => {
    const { commission, driverEarning } = await calculateCommission(fare);

    // Credit driver
    const wallet = await creditWallet(driverId, driverEarning, "cash_in", {
        rideId,
        description: `Cash in (Ride). Amount: ${fare} RWF. Commission: ${commission} RWF.`,
    });

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
 * @param {string} agentId
 * @param {string} driverId
 * @param {number} amount
 */
const agentCashIn = async (agentId, driverId, amount) => {
    const wallet = await creditWallet(driverId, amount, "agent_cash_in", {
        agentId,
        description: `Agent cash-in. Amount: ${amount} RWF`,
    });

    const user = await User.findById(driverId);
    if (user) {
        await sendSMS(
            user.phone,
            `MOTA Wallet\nCash deposit confirmed.\nAmount: ${amount} RWF\nWallet Balance: ${wallet.balance} RWF`,
            "cash_in"
        );
    }

    return wallet;
};

/**
 * Admin credit: manually send money to driver wallet
 * @param {string} adminId
 * @param {string} driverId
 * @param {number} amount
 * @param {string} reason
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
 * Pay fine: deduct from wallet, mark fine paid
 * @param {string} driverId
 * @param {string} fineId  (Mongo _id of Fine doc)
 * @param {number} amount
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
 * @param {string} driverId
 * @param {number} amount
 */
const rewardReferral = async (driverId, amount) => {
    const wallet = await creditWallet(driverId, amount, "referral_reward", {
        description: `Referral reward. Amount: ${amount} RWF`,
    });

    const user = await User.findById(driverId);
    if (user) {
        await sendSMS(
            user.phone,
            `MOTA Referral\nCongratulations! You earned a referral reward of ${amount} RWF.\nWallet Balance: ${wallet.balance} RWF`,
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
    adminCreditWallet,
    payFine,
    rewardReferral,
    COMMISSION_RATE: DEFAULT_COMMISSION_RATE,
};
