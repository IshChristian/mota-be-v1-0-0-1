const Loan = require("../models/Loan");
const Fine = require("../models/Fine");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const User = require("../models/User");
const systemSettingService = require("./systemSettingService");
const { sendSMS } = require("./smsService");
const mongoose = require("mongoose");
const lendingPolicyService = require("./lendingPolicyService");
const repaymentService = require("./repaymentService");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
// Loans still being repaid. "overdue" = a missed installment; it is still collected.
const OPEN = ["active", "overdue"];

/**
 * Request a loan for a fine the driver submitted and an admin approved
 * (POST /api/fine-requests → admin approves → this). The loan pays the fine's
 * remaining amount, capped by the system maximum and the driver's own limit;
 * interest is charged once, on the loan.
 * @param {ObjectId} driverId
 * @param {string}   tinNumber    - 9-digit TIN number
 * @param {string}   ticketNumber - the fine's ticket / reference number
 */
const requestLoan = async (driverId, tinNumber, ticketNumber) => {
    const ticket = String(ticketNumber || "").trim();
    const policy = await lendingPolicyService.checkEligibility(driverId);
    if (!policy.eligible) throw httpError(403, policy.reason);

    const fine = await Fine.findOne({
        driverId,
        $or: [{ ticketNumber: ticket }, { fineId: ticket }],
        status: { $in: ["approved", "partially_paid"] },
    }).sort({ createdAt: -1 });
    if (!fine) {
        throw httpError(404, `No approved fine with ticket number '${ticket}'. Submit the fine for review first; you can request the loan once it is approved.`);
    }
    const remainingFine = Math.max(0, (fine.amount || 0) - (fine.paidAmount || 0));
    if (remainingFine <= 0) throw httpError(409, "This fine is already paid.");

    const existingLoan = await Loan.exists({ fineId: fine._id, loanStatus: { $in: ["pending", ...OPEN] } });
    if (existingLoan) throw httpError(409, "A loan for this ticket is already pending or being repaid.");

    const maxLoanAmount = Number(await systemSettingService.getSetting("fine_loan_max_amount", 50000)) || 0;
    const driverLoanLimit = Number(policy.maxAmount) || 0;
    const loanAmount = Math.min(remainingFine, maxLoanAmount, driverLoanLimit);
    if (loanAmount <= 0) throw httpError(403, "Your current loan limit is 0 RWF. Complete more rides and repay on time to raise it.");

    const interestRate = Number(await systemSettingService.getSetting("fine_loan_interest_rate", 5)) || 0;
    const totalWithInterest = Math.round(loanAmount * (1 + interestRate / 100));

    const loan = await Loan.create({
        driverId,
        fineId: fine._id,
        tinNumber,
        ticketNumber: ticket,
        loanAmount,
        interestRate,
        totalWithInterest,
        remainingBalance: totalWithInterest,
        loanStatus: "pending",
    });

    return {
        loan,
        fineAmount: remainingFine,
        // When the fine is bigger than the limit the loan covers part of it; the driver pays the rest.
        coversWholeFine: loanAmount >= remainingFine,
        driverLoanLimit,
        systemMaxLoan: maxLoanAmount,
    };
};

/**
 * Approve a loan (admin-initiated). MOTA pays the fine; the driver repays the loan.
 */
const approveLoan = async (loanId, adminId) => {
    const maxDurationDays = Number(await systemSettingService.getSetting("fine_loan_max_duration_days", 90)) || 90;
    const issuedAt = new Date();
    const dueDate = new Date(issuedAt.getTime() + maxDurationDays * 86400000);
    // Atomic pending → active: two clicks (or two admins) approve it once.
    const loan = await Loan.findOneAndUpdate(
        { _id: loanId, loanStatus: "pending" },
        { $set: { loanStatus: "active", issuedAt, dueDate, approvedBy: adminId } },
        { returnDocument: "after" }
    );
    if (!loan) {
        if (!(await Loan.exists({ _id: loanId }))) throw httpError(404, "Loan not found");
        throw httpError(409, "Loan is not in pending status");
    }

    // Pay off the fine with this loan
    const fine = await Fine.findById(loan.fineId);
    if (fine) {
        fine.paidAmount = (fine.paidAmount || 0) + loan.loanAmount;
        fine.status = fine.paidAmount >= fine.amount ? "paid" : "partially_paid";
        await fine.save();
    }

    await Transaction.create({
        driverId: loan.driverId,
        amount: loan.loanAmount,
        type: "fine_loan_issued",
        status: "successful",
        reference: String(loan._id),
        description: `Fine loan issued. Amount: ${loan.loanAmount} RWF. Total with interest: ${loan.totalWithInterest} RWF.`,
    });

    try {
        const frequency = await lendingPolicyService.determineRepaymentFrequency(loan.driverId);
        await repaymentService.generateSchedule(loan._id, frequency);
    } catch (error) {
        console.error("Repayment schedule not created:", error.message);
    }

    const driver = await User.findById(loan.driverId);
    if (driver) {
        await sendSMS(
            driver.phone,
            `MOTA: Your fine loan of ${loan.loanAmount} RWF has been approved. Total repayment: ${loan.totalWithInterest} RWF. Auto-deduction will apply to ride earnings.`,
            "fine_loan_issued"
        );
    }

    return loan;
};

/**
 * Reject a loan (admin-initiated)
 */
const rejectLoan = async (loanId, adminId) => {
    const loan = await Loan.findOneAndUpdate(
        { _id: loanId, loanStatus: "pending" },
        { $set: { loanStatus: "rejected", approvedBy: adminId } },
        { returnDocument: "after" }
    );
    if (!loan) {
        if (!(await Loan.exists({ _id: loanId }))) throw httpError(404, "Loan not found");
        throw httpError(409, "Loan is not in pending status");
    }
    return loan;
};

/** Applies `payment` to a loan inside a session; closes it when fully repaid. */
function applyPayment(loan, payment) {
    loan.remainingBalance = Math.max(0, loan.remainingBalance - payment);
    if (loan.remainingBalance === 0) {
        loan.loanStatus = "successful";
        loan.completedAt = new Date();
    }
}

const recordOnSchedule = async (payments) => {
    for (const { loanId, amount, transactionId } of payments) {
        try { await repaymentService.recordRepayment(loanId, amount, transactionId); }
        catch (error) { console.error("Repayment schedule update failed:", error.message); }
    }
};

/**
 * Manual loan repayment from wallet. Wallet debit, loan balance and ledger entry
 * are one transaction, so concurrent repayments can't overdraw the wallet.
 */
const repayLoan = async (loanId, amount, driverId) => {
    const requested = Math.round(Number(amount));
    if (!Number.isFinite(requested) || requested <= 0) throw httpError(400, "Amount must be a positive number");
    if (!mongoose.isValidObjectId(loanId)) throw httpError(404, "Loan not found");

    let loan, wallet, tx, paymentAmount;
    await mongoose.connection.transaction(async (session) => {
        loan = await Loan.findById(loanId).session(session);
        if (!loan) throw httpError(404, "Loan not found");
        if (loan.driverId.toString() !== driverId.toString()) throw httpError(403, "Unauthorized");
        if (!OPEN.includes(loan.loanStatus)) throw httpError(409, "Loan is not active");

        paymentAmount = Math.min(requested, loan.remainingBalance);
        wallet = await Wallet.findOneAndUpdate(
            { driverId, balance: { $gte: paymentAmount } },
            { $inc: { balance: -paymentAmount } },
            { session, returnDocument: "after" }
        );
        if (!wallet) throw httpError(400, `Insufficient wallet balance. Required: ${paymentAmount} RWF`);

        applyPayment(loan, paymentAmount);
        await loan.save({ session });
        [tx] = await Transaction.create([{
            driverId,
            amount: paymentAmount,
            type: "fine_loan_repayment",
            status: "successful",
            reference: String(loan._id),
            description: `Manual loan repayment. Loan remaining: ${loan.remainingBalance} RWF.`,
        }], { session });
    });
    await recordOnSchedule([{ loanId: loan._id, amount: paymentAmount, transactionId: tx._id }]);

    const driver = await User.findById(driverId);
    if (driver) {
        const msg = loan.loanStatus === "successful"
            ? `MOTA: Loan fully repaid! Thank you.`
            : `MOTA: Loan repayment of ${paymentAmount} RWF received. Remaining: ${loan.remainingBalance} RWF.`;
        await sendSMS(driver.phone, msg, "fine_loan_repayment");
    }

    return { loan, walletBalance: wallet.balance };
};

/**
 * Auto-deduct loan repayment from ride earnings (after the ride payment is credited).
 * Takes the configured % of the ride, but never more than the wallet holds, and
 * reduces the loans only by what was actually taken. Returns the amount deducted.
 */
const autoDeductFromRide = async (driverId, rideEarning) => {
    if (!(await Loan.exists({ driverId, loanStatus: { $in: OPEN } }))) return 0;
    const repaymentPercentage = Number(await systemSettingService.getSetting("fine_loan_auto_repayment_percentage", 10)) || 0;
    const deductionAmount = Math.round((Number(rideEarning) || 0) * (repaymentPercentage / 100));
    if (deductionAmount <= 0) return 0;

    let totalDeducted = 0;
    let payments = [];
    await mongoose.connection.transaction(async (session) => {
        totalDeducted = 0;
        payments = [];
        const openLoans = await Loan.find({ driverId, loanStatus: { $in: OPEN } }).sort({ issuedAt: 1 }).session(session);
        const owed = openLoans.reduce((sum, l) => sum + l.remainingBalance, 0);
        const wallet = await Wallet.findOne({ driverId }).session(session);
        const take = Math.min(deductionAmount, owed, Math.max(0, wallet?.balance || 0));
        if (take <= 0) return;

        const debited = await Wallet.updateOne({ _id: wallet._id, balance: { $gte: take } }, { $inc: { balance: -take } }, { session });
        if (!debited.modifiedCount) return;

        let remaining = take;
        for (const loan of openLoans) {
            if (remaining <= 0) break;
            const payment = Math.min(remaining, loan.remainingBalance);
            if (payment <= 0) continue;
            applyPayment(loan, payment);
            await loan.save({ session });
            const [tx] = await Transaction.create([{
                driverId,
                amount: payment,
                type: "fine_loan_repayment",
                status: "successful",
                reference: String(loan._id),
                description: `Auto loan repayment (${repaymentPercentage}% of ride). Loan remaining: ${loan.remainingBalance} RWF.`,
            }], { session });
            payments.push({ loanId: loan._id, amount: payment, transactionId: tx._id });
            remaining -= payment;
            totalDeducted += payment;
        }
    });
    await recordOnSchedule(payments);
    return totalDeducted;
};

/**
 * Get loans for a driver
 */
const getDriverLoans = async (driverId) => {
    return await Loan.find({ driverId })
        .populate("fineId", "fineId amount status")
        .sort({ createdAt: -1 });
};

/**
 * Get all loans (admin)
 */
const getAllLoans = async (status = null, page = 1, limit = 20) => {
    const filter = status ? { loanStatus: status } : {};
    const skip = (page - 1) * limit;
    const loans = await Loan.find(filter)
        .populate("driverId", "firstName lastName phone")
        .populate("fineId", "fineId amount status")
        .populate("approvedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
    const total = await Loan.countDocuments(filter);
    return { loans, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

/**
 * Check and mark overdue loans
 */
const checkOverdueLoans = async () => {
    const now = new Date();
    const overdue = await Loan.updateMany(
        { loanStatus: { $in: OPEN }, dueDate: { $lt: now } },
        { $set: { loanStatus: "defaulted" } }
    );
    return overdue.modifiedCount;
};

module.exports = {
    requestLoan,
    approveLoan,
    rejectLoan,
    repayLoan,
    autoDeductFromRide,
    getDriverLoans,
    getAllLoans,
    checkOverdueLoans,
};
