const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const walletService = require("../services/walletService");
const paymentService = require("../services/paymentService");
const User = require("../models/User");
const { sendSMS } = require("../services/smsService");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const withdrawalService = require("../services/withdrawalService");

/**
 * GET /api/wallet/balance
 * Get driver's full wallet summary: balance, today, fines, all-time, recent transactions
 */
const getBalance = async (req, res) => {
    try {
        const driverId = req.user.id;
        const summary = await walletService.getWalletSummary(driverId);

        res.status(200).json(summary);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/wallet/summary
 * Alias — full wallet summary with all calculated amounts
 */
const getSummary = async (req, res) => {
    try {
        const driverId = req.user.id;
        const summary = await walletService.getWalletSummary(driverId);

        res.status(200).json({
            message: "Wallet summary retrieved",
            data: summary,
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
        const idempotencyKey = req.get("Idempotency-Key");

        if (!Number.isInteger(Number(amount)) || Number(amount) < 100) {
            return res.status(400).json({ message: "Cash-in amount must be a whole number of at least 100 RWF." });
        }
        if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 32) {
            return res.status(400).json({ message: "A valid Idempotency-Key header is required." });
        }

        const user = await User.findById(driverId);
        if (!user) return res.status(404).json({ message: "User not found." });
        const recipientPhone = phone || user.phone;
        const existing = await Transaction.findOne({ idempotencyKey, driverId, type: "cash_in" });
        if (existing) {
            return res.status(existing.paypackRef ? 200 : 409).json({
                message: existing.paypackRef
                    ? "Cash-in request already initiated."
                    : "The previous cash-in attempt did not reach Paypack. Submit again to create a new request.",
                ref: existing.paypackRef,
                amount: existing.amount,
                status: existing.status,
                replayed: true,
            });
        }

        const pending = await Transaction.create({
            driverId,
            amount: Number(amount),
            type: "cash_in",
            status: "pending",
            idempotencyKey,
            senderPhone: recipientPhone,
            receiverPhone: "MOTA",
            description: `Digital cash-in request. Amount: ${amount} RWF`,
        });

        const result = await paymentService.requestCashIn(
            recipientPhone,
            Number(amount),
            process.env.PAYPACK_ENV || "development"
        );

        if (!result.success) {
            pending.status = "failed";
            pending.description = `Cash-in initiation failed. Amount: ${amount} RWF`;
            await pending.save();
            return res.status(502).json({ message: "Payment gateway error", error: result.error });
        }

        pending.paypackRef = result.data?.ref;
        await pending.save();

        return res.status(200).json({
            message: "Cash-in request initiated. Complete payment on your phone.",
            ref: result.data?.ref,
            amount,
        });
    } catch (error) {
        if (error?.code === 11000) {
            const existing = await Transaction.findOne({
                idempotencyKey: req.get("Idempotency-Key"),
                driverId: req.user.id,
                type: "cash_in",
            });
            if (existing) {
                return res.status(200).json({
                    message: "Cash-in request already initiated.",
                    ref: existing.paypackRef,
                    amount: existing.amount,
                    status: existing.status,
                    replayed: true,
                });
            }
        }
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
        const idempotencyKey = req.get("Idempotency-Key");

        if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 32) {
            return res.status(400).json({ message: "A valid Idempotency-Key header is required." });
        }

        const user = await User.findById(driverId);
        if (!user || !user.phone) {
            return res.status(400).json({ message: "Driver phone number not found." });
        }

        const result = await withdrawalService.requestWithdrawal({
            driverId: driverId.toString(),
            amount,
            phone: user.phone,
            idempotencyKey,
        });
        const queued = result.dispatch.status === "queued";
        return res.status(202).json({
            message: queued
                ? `${amount} RWF is reserved and queued. Paypack payout starts when this account's queued withdrawals reach ${withdrawalService.PAYPACK_MINIMUM} RWF.`
                : `Withdrawal reserved. Paypack payout of ${result.dispatch.payoutAmount} RWF is pending.`,
            data: {
                requestId: result.request._id,
                requestedAmount: result.request.amount,
                fee: result.request.fee,
                status: result.dispatch.status,
                queuedTotal: result.dispatch.queuedTotal,
                remainingToDispatch: result.dispatch.remainingToDispatch,
                paypackRef: result.dispatch.paypackRef,
                replayed: result.replayed,
            },
        });
    } catch (error) {
        const clientError = /amount|balance|idempotency|Paypack|queue changed/i.test(error.message);
        res.status(clientError ? 400 : 500).json({
            message: clientError ? error.message : "Server error",
            ...(clientError ? {} : { error: error.message }),
        });
    }
};

const getWithdrawals = async (req, res) => {
    const items = await WithdrawalRequest.find({ driverId: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.status(200).json({ data: items, paypackMinimum: withdrawalService.PAYPACK_MINIMUM });
};

/**
 * GET /api/wallet/transactions
 * Driver transaction history (paginated, with optional type filter)
 */
const getTransactions = async (req, res) => {
    try {
        const driverId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        const typeFilter = req.query.type; // optional filter by transaction type

        const query = { driverId };
        if (typeFilter) {
            query.type = typeFilter;
        }

        const transactions = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate("driverId", "firstName lastName phone profilePicture email");

        const total = await Transaction.countDocuments(query);

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
    getSummary,
    cashIn,
    requestCashOut,
    getWithdrawals,
    getTransactions,
};
