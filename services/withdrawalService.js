const crypto = require("crypto");
const mongoose = require("mongoose");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const configService = require("./configService");
const paymentService = require("./paymentService");

const STAFF_ROLES = ["superadmin", "admin", "financial", "agent", "caller_support", "manager", "moderator"];
const ALERT_TITLE = "Automatic cash-out failed";

/** A short, human-readable reason from whatever the provider returned. */
const providerReason = (result) => {
    const raw = result?.error?.message || result?.error || result?.message || "Paypack did not return a payout reference";
    return (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 300);
};
/** Provider reply kept for the record, trimmed and without anything resembling credentials. */
const recordable = (result) => {
    try {
        const text = JSON.stringify(result ?? null, (key, value) => (/token|secret|authorization|password/i.test(key) ? "[removed]" : value));
        return JSON.parse(text.length > 2000 ? JSON.stringify({ truncated: text.slice(0, 2000) }) : text);
    } catch { return null; }
};

/**
 * Tell every active staff member who can manage withdrawals that an automatic
 * payout failed and needs a manual payout or a return to the wallet.
 */
const alertManualPayout = async (request, reason) => {
    const User = require("../models/User");
    const notificationService = require("./notificationService");
    const { effectivePermissions } = require("./reportAccess");
    const [owner, staff] = await Promise.all([
        User.findById(request.driverId).select("firstName lastName").lean(),
        User.find({ role: { $in: STAFF_ROLES }, isActive: true }).select("role roleId reportPermissions permissionGrants permissionRevokes").populate("roleId", "permissions").lean(),
    ]);
    const recipients = staff.filter((member) => effectivePermissions(member).includes("withdrawal:manage"));
    const name = owner ? `${owner.firstName || ""} ${owner.lastName || ""}`.trim() : "unknown user";
    const message = `Automatic cash-out of ${request.amount} RWF for user ${name} (${request.driverId}) failed: ${reason}. Pay it manually or return it to the wallet.`;
    await Promise.allSettled(recipients.map((member) => notificationService.createNotification(
        member._id, ALERT_TITLE, message, "in_app", { withdrawalRequestId: String(request._id), userId: String(request.driverId) },
    )));
    await WithdrawalRequest.updateOne({ _id: request._id }, { $set: { alertedAt: new Date(), alertedStaff: recipients.map((m) => m._id) } });
};

/**
 * Send one withdrawal request to Paypack. `auto` takes a newly queued request,
 * `retry` one waiting for staff. Accepted → provider_pending (the webhook
 * settles it). Refused or errored → manual_required: the money stays held and
 * withdrawal managers are alerted. Every attempt is recorded.
 */
const dispatchRequest = async (requestId, kind = "auto") => {
    const from = kind === "retry" ? "manual_required" : "queued";
    const batchId = crypto.randomUUID();
    const claimed = await WithdrawalRequest.findOneAndUpdate(
        { _id: requestId, status: from },
        { $set: { status: "processing", batchId } },
        { returnDocument: "after" },
    );
    if (!claimed) {
        const current = await WithdrawalRequest.findById(requestId).select("status paypackRef").lean();
        return { status: current?.status || "missing", paypackRef: current?.paypackRef };
    }
    await Transaction.updateMany({ reference: String(claimed._id), type: "cash_out", status: "pending" }, { $set: { batchId } });

    let result;
    try {
        result = await paymentService.requestCashOut(claimed.phone, claimed.amount, process.env.PAYPACK_ENV || "development");
    } catch (error) {
        result = { success: false, error: error?.message || String(error) };
    }
    const paypackRef = result?.success ? result.data?.ref : undefined;
    const attempt = { at: new Date(), kind, ok: !!paypackRef, paypackRef, reason: paypackRef ? undefined : providerReason(result), response: recordable(result) };

    if (paypackRef) {
        await WithdrawalRequest.updateOne({ _id: claimed._id, status: "processing" }, { $set: { status: "provider_pending", paypackRef }, $unset: { failureReason: 1 }, $push: { attempts: attempt } });
        await Transaction.updateMany({ reference: String(claimed._id), type: "cash_out", status: "pending" }, { $set: { paypackRef } });
        return { status: "provider_pending", paypackRef };
    }
    await WithdrawalRequest.updateOne({ _id: claimed._id, status: "processing" }, { $set: { status: "manual_required", failureReason: attempt.reason }, $push: { attempts: attempt } });
    try { await alertManualPayout(claimed, attempt.reason); } catch (error) { console.error("Manual payout alert failed:", error.message); }
    return { status: "manual_required", reason: attempt.reason };
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
                { returnDocument: "after", session },
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

    const dispatch = await dispatchRequest(request._id, "auto");
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

/**
 * A request left in "processing" (server restarted while talking to Paypack)
 * would hold money with nobody told. After `olderThanMs` it goes to staff
 * like a refusal, with a warning to check Paypack before paying manually.
 */
const STUCK_REASON = "Payout status unknown: the server restarted while sending it to Paypack. Check Paypack for this payout before paying manually.";
const recoverStuckDispatches = async (olderThanMs = 10 * 60 * 1000) => {
    const stuck = await WithdrawalRequest.find({ status: "processing", updatedAt: { $lt: new Date(Date.now() - olderThanMs) } }).select("_id").lean();
    let moved = 0;
    for (const { _id } of stuck) {
        const request = await WithdrawalRequest.findOneAndUpdate(
            { _id, status: "processing" },
            { $set: { status: "manual_required", failureReason: STUCK_REASON }, $push: { attempts: { at: new Date(), kind: "auto", ok: false, reason: STUCK_REASON } } },
            { returnDocument: "after" },
        );
        if (!request) continue;
        moved += 1;
        try { await alertManualPayout(request, STUCK_REASON); } catch (error) { console.error("Manual payout alert failed:", error.message); }
    }
    return moved;
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Close a withdrawal that is waiting for staff. "paid": staff paid it outside
 * the system, so the held money leaves for good. "returned": the held money
 * goes back to the user's wallet. The conditional status change makes a
 * second click (or a second staff member) a 409, so money moves once.
 */
const closeManually = async (id, staffId, { action, reference, note }) => {
    let closed = null;
    await mongoose.connection.transaction(async (session) => {
        closed = null;
        const paid = action === "paid";
        const request = await WithdrawalRequest.findOneAndUpdate(
            { _id: id, status: "manual_required" },
            { $set: {
                status: paid ? "successful" : "failed",
                manual: { action, by: staffId, at: new Date(), reference, note },
                ...(paid ? {} : { failureReason: "Returned to the wallet by MOTA staff" }),
            } },
            { returnDocument: "after", session },
        );
        if (!request) return;
        const walletUpdate = await Wallet.updateOne(
            { driverId: request.driverId, heldBalance: { $gte: request.totalHeld } },
            { $inc: paid ? { heldBalance: -request.totalHeld } : { balance: request.totalHeld, heldBalance: -request.totalHeld } },
            { session },
        );
        if (walletUpdate.modifiedCount !== 1) throw new Error("Held withdrawal balance is inconsistent.");
        await Transaction.updateMany(
            { reference: String(request._id), type: "cash_out", status: "pending" },
            { $set: {
                status: paid ? "successful" : "failed",
                description: paid
                    ? `Withdrawal paid manually by MOTA (MoMo reference ${reference}).`
                    : "Withdrawal returned to your wallet by MOTA.",
            } },
            { session },
        );
        if (paid && request.fee > 0) {
            await Transaction.create([{
                driverId: request.driverId, amount: -request.fee, feeAmount: request.fee, type: "cash_out_fee", status: "successful",
                reference: String(request._id), idempotencyKey: `${request.idempotencyKey}:fee`, description: `Cash-out fee: ${request.fee} RWF.`,
            }], { session });
        }
        closed = request;
    });
    if (!closed) throw httpError(409, "This withdrawal is no longer waiting for manual handling.");
    const notificationService = require("./notificationService");
    const message = action === "paid"
        ? `Your ${closed.amount} RWF withdrawal has been paid.`
        : `Your ${closed.amount} RWF withdrawal could not be paid and is back in your wallet.`;
    await notificationService.createNotification(closed.driverId, action === "paid" ? "Withdrawal paid" : "Withdrawal returned to your wallet", message, "in_app", { requestId: String(closed._id) }).catch(() => {});
    return closed;
};

const markPaidManually = (id, staffId, { reference, note }) => closeManually(id, staffId, { action: "paid", reference, note });
const returnToWallet = (id, staffId, { note }) => closeManually(id, staffId, { action: "returned", note });
const retryPayout = async (id) => {
    const result = await dispatchRequest(id, "retry");
    if (!["provider_pending", "manual_required"].includes(result.status)) throw httpError(409, "Only a withdrawal waiting for manual handling can be retried.");
    return result;
};

module.exports = { dispatchRequest, alertManualPayout, recoverStuckDispatches, requestWithdrawal, settleWebhook, markPaidManually, returnToWallet, retryPayout, ALERT_TITLE };
