const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const walletService = require("../services/walletService");
const paymentService = require("../services/paymentService");
const User = require("../models/User");
const { sendSMS } = require("../services/smsService");

/**
 * GET /api/wallet/balance
 * Get driver's wallet balance and recent transactions
 */
const getBalance = async (req, res) => {
    try {
        const driverId = req.user.id;
        const wallet = await walletService.getOrCreateWallet(driverId);

        const transactions = await Transaction.find({ driverId })
            .sort({ createdAt: -1 })
            .limit(20);

        res.status(200).json({
            balance: wallet.balance,
            fuelCredits: wallet.fuelCredits || 0,
            transactions,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/wallet/cash-in
 * Driver digital cash-in via Paypack
 */
const cashIn = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { amount, phone } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "Valid amount is required" });
        }

        const user = await User.findById(driverId);
        const recipientPhone = phone || user.phone;

        const result = await paymentService.requestCashIn(
            recipientPhone,
            amount,
            process.env.PAYPACK_ENV || "development"
        );

        if (!result.success) {
            return res.status(502).json({ message: "Payment gateway error", error: result.error });
        }

        // Record pending transaction
        await Transaction.create({
            driverId,
            amount,
            type: "cash_in",
            status: "pending",
            paypackRef: result.data?.ref,
            description: `Digital cash-in request. Amount: ${amount} RWF`,
        });

        res.status(200).json({
            message: "Cash-in request initiated. Complete payment on your phone.",
            ref: result.data?.ref,
            amount,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/wallet/cash-out
 * Driver withdrawal request — goes to admin for approval
 */
const requestCashOut = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "Valid amount is required" });
        }

        const user = await User.findById(driverId);
        if (!user || !user.phone) {
            return res.status(400).json({ message: "Driver phone number not found." });
        }

        // Process cash-out with fee deduction
        let cashOutResult;
        try {
            cashOutResult = await walletService.processCashOut(driverId.toString(), amount);
        } catch (err) {
            return res.status(400).json({ message: err.message });
        }

        // Paypack Cash Out to driver's phone
        const result = await paymentService.requestCashOut(
            user.phone,
            amount,
            process.env.PAYPACK_ENV || "development"
        );

        if (result.success) {
            return res.status(200).json({
                message: `Success! ${amount} RWF has been sent to your MoMo account (${user.phone}). Fee: ${cashOutResult.fee} RWF.`,
                amount,
                fee: cashOutResult.fee,
                totalDeducted: cashOutResult.totalDeduction,
                newBalance: cashOutResult.wallet.balance,
            });
        } else {
            // Rollback on failure
            await walletService.creditWallet(driverId.toString(), cashOutResult.totalDeduction, "cash_out_refund", {
                description: "Refund for failed cash-out (includes fee)"
            });
            return res.status(502).json({ message: "Gateway error. Cash-out failed. Your balance is restored." });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/wallet/transactions
 * Driver transaction history (paginated)
 */
const getTransactions = async (req, res) => {
    try {
        const driverId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const transactions = await Transaction.find({ driverId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Transaction.countDocuments({ driverId });

        res.status(200).json({
            transactions,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getBalance,
    cashIn,
    requestCashOut,
    getTransactions,
};
