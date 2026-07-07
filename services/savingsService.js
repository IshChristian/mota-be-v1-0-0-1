const SavingsAccount = require("../models/SavingsAccount");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const auditService = require("./auditService");
const { sendSMS } = require("./smsService");
const systemSettingService = require("./systemSettingService");

/**
 * Get or create a savings account for a driver
 */
const getOrCreateAccount = async (driverId) => {
    let account = await SavingsAccount.findOne({ driverId });
    if (!account) {
        account = await SavingsAccount.create({ driverId });
    }
    return account;
};

/**
 * Get savings account summary
 */
const getAccountSummary = async (driverId) => {
    const account = await getOrCreateAccount(driverId);

    // Calculate days held (for reward eligibility)
    const oldestDeposit = account.deposits.length > 0
        ? account.deposits.reduce((min, d) => d.depositedAt < min ? d.depositedAt : min, account.deposits[0].depositedAt)
        : null;

    const daysHeld = oldestDeposit
        ? Math.floor((Date.now() - new Date(oldestDeposit).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

    return {
        balance: account.balance,
        totalDeposited: account.totalDeposited,
        totalWithdrawn: account.totalWithdrawn,
        rewardAccrued: account.rewardAccrued,
        daysHeld,
        rewardEligible: daysHeld >= 30,
        status: account.status,
        recentDeposits: account.deposits.slice(-5).reverse(),
        recentWithdrawals: account.withdrawals.slice(-5).reverse(),
    };
};

/**
 * Deposit funds from wallet into savings
 */
const deposit = async (driverId, amount, source = "wallet") => {
    if (amount <= 0) throw new Error("Deposit amount must be positive");

    const account = await getOrCreateAccount(driverId);
    if (account.status !== "active") throw new Error("Savings account is frozen or closed");

    // Debit from wallet
    if (source === "wallet") {
        const wallet = await Wallet.findOne({ driverId });
        if (!wallet || wallet.balance < amount) {
            throw new Error(`Insufficient wallet balance. Available: ${wallet?.balance || 0} RWF`);
        }
        wallet.balance -= amount;
        await wallet.save();
    }

    // Record transaction
    const tx = await Transaction.create({
        driverId,
        amount: -amount,
        type: "savings_deposit",
        status: "successful",
        description: `Savings deposit. Amount: ${amount} RWF`,
    });

    // Credit savings
    account.balance += amount;
    account.totalDeposited += amount;
    account.deposits.push({
        amount,
        depositedAt: new Date(),
        source,
        transactionId: tx._id,
    });
    await account.save();

    await auditService.log({
        actorId: driverId,
        actorRole: "driver",
        action: "savings_deposit",
        targetType: "SavingsAccount",
        targetId: account._id,
        metadata: { amount, source, newBalance: account.balance },
    });

    return { account, transactionId: tx._id };
};

/**
 * Withdraw funds from savings to wallet
 */
const withdraw = async (driverId, amount, destination = "wallet") => {
    if (amount <= 0) throw new Error("Withdrawal amount must be positive");

    const account = await getOrCreateAccount(driverId);
    if (account.status !== "active") throw new Error("Savings account is frozen or closed");
    if (account.balance < amount) {
        throw new Error(`Insufficient savings balance. Available: ${account.balance} RWF`);
    }

    // Debit savings
    account.balance -= amount;
    account.totalWithdrawn += amount;

    // Record transaction
    const tx = await Transaction.create({
        driverId,
        amount,
        type: "savings_withdrawal",
        status: "successful",
        description: `Savings withdrawal. Amount: ${amount} RWF`,
    });

    account.withdrawals.push({
        amount,
        withdrawnAt: new Date(),
        destination,
        transactionId: tx._id,
    });
    await account.save();

    // Credit wallet
    if (destination === "wallet") {
        const wallet = await Wallet.findOne({ driverId });
        if (wallet) {
            wallet.balance += amount;
            await wallet.save();
        }
    }

    await auditService.log({
        actorId: driverId,
        actorRole: "driver",
        action: "savings_withdrawal",
        targetType: "SavingsAccount",
        targetId: account._id,
        metadata: { amount, destination, newBalance: account.balance },
    });

    return { account, transactionId: tx._id };
};

/**
 * Calculate and distribute monthly savings rewards.
 * Runs via cronService once per month.
 * Only rewards balances held for 30+ days.
 */
const calculateRewards = async () => {
    const rewardRate = await systemSettingService.getSetting("savings_monthly_reward_rate", 2); // 2% per month
    const accounts = await SavingsAccount.find({ status: "active", balance: { $gt: 0 } });

    let rewardedCount = 0;

    for (const account of accounts) {
        // Check if oldest unrewarded deposit is 30+ days old
        const lastReward = account.lastRewardDate || account.createdAt;
        const daysSinceReward = Math.floor((Date.now() - new Date(lastReward).getTime()) / (1000 * 60 * 60 * 24));

        if (daysSinceReward < 30) continue;

        const reward = Math.round(account.balance * (rewardRate / 100));
        if (reward <= 0) continue;

        account.balance += reward;
        account.rewardAccrued += reward;
        account.lastRewardDate = new Date();
        await account.save();

        // Record reward transaction
        await Transaction.create({
            driverId: account.driverId,
            amount: reward,
            type: "savings_reward",
            status: "successful",
            description: `Monthly savings reward (${rewardRate}%). Reward: ${reward} RWF`,
        });

        await auditService.log({
            actorRole: "system",
            action: "savings_reward",
            targetType: "SavingsAccount",
            targetId: account._id,
            metadata: { reward, rate: rewardRate, balance: account.balance },
        });

        // Notify driver
        const driver = await User.findById(account.driverId);
        if (driver) {
            await sendSMS(
                driver.phone,
                `MOTA Savings: You earned ${reward} RWF reward! Your savings balance is now ${account.balance} RWF. Keep saving!`,
                "savings_reward"
            );
        }

        rewardedCount++;
    }

    return rewardedCount;
};

/**
 * Admin: Get overview of all savings
 */
const getAdminOverview = async () => {
    const [totalAgg, activeCount, frozenCount] = await Promise.all([
        SavingsAccount.aggregate([
            { $match: { status: "active" } },
            {
                $group: {
                    _id: null,
                    totalBalance: { $sum: "$balance" },
                    totalDeposited: { $sum: "$totalDeposited" },
                    totalWithdrawn: { $sum: "$totalWithdrawn" },
                    totalRewards: { $sum: "$rewardAccrued" },
                },
            },
        ]),
        SavingsAccount.countDocuments({ status: "active", balance: { $gt: 0 } }),
        SavingsAccount.countDocuments({ status: "frozen" }),
    ]);

    const totals = totalAgg[0] || { totalBalance: 0, totalDeposited: 0, totalWithdrawn: 0, totalRewards: 0 };

    return {
        activeAccounts: activeCount,
        frozenAccounts: frozenCount,
        totalSavingsBalance: totals.totalBalance,
        totalDeposited: totals.totalDeposited,
        totalWithdrawn: totals.totalWithdrawn,
        totalRewardsDistributed: totals.totalRewards,
        platformFloat: totals.totalBalance, // This amount must be held in bank partner account
    };
};

module.exports = {
    getOrCreateAccount,
    getAccountSummary,
    deposit,
    withdraw,
    calculateRewards,
    getAdminOverview,
};
