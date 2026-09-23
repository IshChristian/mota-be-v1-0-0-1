const crypto = require("crypto");
const mongoose = require("mongoose");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const configService = require("./configService");
const paymentService = require("./paymentService");

const PAYPACK_MINIMUM = Number(process.env.PAYPACK_CASHOUT_MINIMUM || 10000);

const releaseBatch = async (batchId, reason) => {
    await mongoose.connection.transaction(async (session) => {
        const requests = await WithdrawalRequest.find({ batchId, status: "processing" }).session(session);
        if (!requests.length) return;
        const totalHeld = requests.reduce((sum, item) => sum + item.totalHeld, 0);
        const walletUpdate = await Wallet.updateOne(
            { driverId: requests[0].driverId, heldBalance: { $gte: totalHeld } },
            { $inc: { balance: totalHeld, heldBalance: -totalHeld } },
            { session },
        );
        if (walletUpdate.modifiedCount !== 1) throw new Error("Held withdrawal balance is inconsistent.");
        await WithdrawalRequest.updateMany(
            { batchId, status: "processing" },
            { $set: { status: "failed", failureReason: reason } },
            { session },
        );
        await Transaction.updateMany(
            { batchId, type: "cash_out", status: "pending" },
            { $set: { status: "failed", description: `Withdrawal failed: ${reason}` } },
            { session },
        );
    });
};

const dispatchQueued = async (driverId, phone) => {
    let claimed = [];
    let batchId = null;
    let payoutAmount = 0;

    await mongoose.connection.transaction(async (session) => {
        const queued = await WithdrawalRequest.find({ driverId, status: "queued" })
            .sort({ createdAt: 1 })
            .session(session);
        payoutAmount = queued.reduce((sum, item) => sum + item.amount, 0);
        if (payoutAmount < PAYPACK_MINIMUM) return;

        batchId = crypto.randomUUID();
        const ids = queued.map((item) => item._id);
        const claim = await WithdrawalRequest.updateMany(
            { _id: { $in: ids }, status: "queued" },
            { $set: { status: "processing", batchId } },
            { session },
        );
        if (claim.modifiedCount !== ids.length) throw new Error("Withdrawal queue changed; retry the request.");
        await Transaction.updateMany(
            { reference: { $in: ids.map(String) }, type: "cash_out", status: "pending" },
            { $set: { batchId } },
            { session },
        );
        claimed = queued;
    });

    if (!claimed.length) {
        const queuedTotal = await WithdrawalRequest.aggregate([
            { $match: { driverId: new mongoose.Types.ObjectId(driverId), status: "queued" } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
        ]);
        const total = queuedTotal[0]?.total || 0;
        return { status: "queued", queuedTotal: total, remainingToDispatch: Math.max(0, PAYPACK_MINIMUM - total) };
    }

    const result = await paymentService.requestCashOut(
        phone,
        payoutAmount,
        process.env.PAYPACK_ENV || "development",
    );
    if (!result.success || !result.data?.ref) {
        await releaseBatch(batchId, "Paypack rejected the payout batch");
        throw new Error("Paypack could not start the withdrawal. Reserved funds were restored.");
    }

    const paypackRef = result.data.ref;
    await mongoose.connection.transaction(async (session) => {
        await WithdrawalRequest.updateMany(
            { batchId, status: "processing" },
            { $set: { status: "provider_pending", paypackRef } },
            { session },
        );
        await Transaction.updateMany(
            { batchId, type: "cash_out", status: "pending" },
            { $set: { paypackRef } },
            { session },
        );
    });
    return { status: "provider_pending", batchId, paypackRef, payoutAmount, requestCount: claimed.length };
};

const requestWithdrawal = async ({ driverId, amount, phone, idempotencyKey }) => {
    const numericAmount = Number(amount);
    if (!Number.isInteger(numericAmount) || numericAmount < 100) {
        throw new Error("Withdrawal amount must be a whole number of at least 100 RWF.");
    }

    const existing = await WithdrawalRequest.findOne({ idempotencyKey });
    if (existing) {
        if (existing.driverId.toString() !== driverId.toString()) throw new Error("Invalid idempotency key.");
        return { request: existing, dispatch: { status: existing.status }, replayed: true };
    }

    const feePercentage = await configService.getConfig("cash_out_fee_percentage", 2);
    const fee = Math.round(numericAmount * (feePercentage / 100));
    const totalHeld = numericAmount + fee;
    let request;

    try {
        await mongoose.connection.transaction(async (session) => {
            const wallet = await Wallet.findOneAndUpdate(
                { driverId, balance: { $gte: totalHeld } },
                { $inc: { balance: -totalHeld, heldBalance: totalHeld } },
                { new: true, session },
            );
            if (!wallet) throw new Error(`Insufficient available balance. Required ${totalHeld} RWF including fee.`);

            [request] = await WithdrawalRequest.create([{
                driverId,
                amount: numericAmount,
                fee,
                totalHeld,
                phone,
                idempotencyKey,
            }], { session });
            await Transaction.create([{
                driverId,
                amount: -numericAmount,
                feeAmount: fee,
                type: "cash_out",
                status: "pending",
                reference: request._id.toString(),
                idempotencyKey,
                senderPhone: "MOTA",
                receiverPhone: phone,
                description: `Withdrawal reserved. Amount: ${numericAmount} RWF. Fee: ${fee} RWF.`,
            }], { session });
        });
    } catch (error) {
        if (error?.code === 11000) {
            const replay = await WithdrawalRequest.findOne({ idempotencyKey });
            if (replay && replay.driverId.toString() === driverId.toString()) {
                return { request: replay, dispatch: { status: replay.status }, replayed: true };
            }
        }
        throw error;
    }

    const dispatch = await dispatchQueued(driverId.toString(), phone);
    return { request, dispatch, replayed: false };
};

const settleWebhook = async (paypackRef, status, kind, amount, payload) => {
    const requests = await WithdrawalRequest.find({ paypackRef, status: "provider_pending" });
    if (!requests.length) return { handled: false };

    if (String(kind).toUpperCase() !== "CASHOUT") {
        throw new Error("Paypack event type does not match the pending withdrawal.");
    }
    const expectedAmount = requests.reduce((sum, item) => sum + item.amount, 0);
    if (Number(amount) !== expectedAmount) {
        throw new Error("Paypack payout amount does not match the reserved withdrawal batch.");
    }

    if (status === "successful") {
        await mongoose.connection.transaction(async (session) => {
            const pending = await WithdrawalRequest.find({ paypackRef, status: "provider_pending" }).session(session);
            if (!pending.length) return;
            const totalHeld = pending.reduce((sum, item) => sum + item.totalHeld, 0);
            const walletUpdate = await Wallet.updateOne(
                { driverId: pending[0].driverId, heldBalance: { $gte: totalHeld } },
                { $inc: { heldBalance: -totalHeld } },
                { session },
            );
            if (walletUpdate.modifiedCount !== 1) throw new Error("Held withdrawal balance is inconsistent.");
            await WithdrawalRequest.updateMany(
                { paypackRef, status: "provider_pending" },
                { $set: { status: "successful", providerEvent: payload } },
                { session },
            );
            await Transaction.updateMany(
                { paypackRef, type: "cash_out", status: "pending" },
                { $set: { status: "successful", paypackEvent: payload } },
                { session },
            );
            const feeTransactions = pending.filter((item) => item.fee > 0).map((item) => ({
                driverId: item.driverId,
                amount: -item.fee,
                feeAmount: item.fee,
                type: "cash_out_fee",
                status: "successful",
                reference: item._id.toString(),
                idempotencyKey: `${item.idempotencyKey}:fee`,
                paypackRef,
                description: `Cash-out fee: ${item.fee} RWF.`,
            }));
            if (feeTransactions.length) await Transaction.create(feeTransactions, { session });
        });
    } else if (status === "failed") {
        await mongoose.connection.transaction(async (session) => {
            const pending = await WithdrawalRequest.find({ paypackRef, status: "provider_pending" }).session(session);
            if (!pending.length) return;
            const totalHeld = pending.reduce((sum, item) => sum + item.totalHeld, 0);
            const walletUpdate = await Wallet.updateOne(
                { driverId: pending[0].driverId, heldBalance: { $gte: totalHeld } },
                { $inc: { balance: totalHeld, heldBalance: -totalHeld } },
                { session },
            );
            if (walletUpdate.modifiedCount !== 1) throw new Error("Held withdrawal balance is inconsistent.");
            await WithdrawalRequest.updateMany(
                { paypackRef, status: "provider_pending" },
                { $set: { status: "failed", failureReason: "Paypack payout failed", providerEvent: payload } },
                { session },
            );
            await Transaction.updateMany(
                { paypackRef, type: "cash_out", status: "pending" },
                { $set: { status: "failed", paypackEvent: payload } },
                { session },
            );
        });
    }
    return { handled: true };
};

module.exports = { PAYPACK_MINIMUM, requestWithdrawal, settleWebhook };
