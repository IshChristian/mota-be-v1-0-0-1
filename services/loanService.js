const Loan = require("../models/Loan");
const Fine = require("../models/Fine");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const User = require("../models/User");
const systemSettingService = require("./systemSettingService");
const { sendSMS } = require("./smsService");
const riskScoringService = require("./riskScoringService");

/**
 * Request a fine loan (driver-initiated)
 * @param {ObjectId} driverId
 * @param {string}   tinNumber    - 9-digit TIN number
 * @param {string}   ticketNumber - Traffic ticket/fine reference number
 */
const requestLoan = async (driverId, tinNumber, ticketNumber) => {
    // ── 1. Uniqueness: reject if same ticketNumber already used for this TIN ──
    const duplicateTicket = await Fine.findOne({ fineId: tinNumber, ticketNumber });
    if (duplicateTicket) {
        // Also check if that fine already has an active/pending loan
        const duplicateLoan = await Loan.findOne({
            fineId: duplicateTicket._id,
            loanStatus: { $in: ["pending", "active"] },
        });
        if (duplicateLoan) {
            throw new Error(`Ticket number '${ticketNumber}' has already been used to request a loan for this TIN number.`);
        }
    }

    // ── 2. Find or auto-create the Fine record for this TIN ─────────────
    let fine = await Fine.findOne({ fineId: tinNumber, ticketNumber });

    if (!fine) {
        fine = await Fine.create({
            driverId,
            fineId: tinNumber,
            ticketNumber,
            amount: 0,
            status: "pending",
        });
    } else {
        if (fine.driverId.toString() !== driverId.toString()) {
            throw new Error("This fine does not belong to your account.");
        }
        if (fine.status === "paid") {
            throw new Error("This fine is already paid.");
        }
    }

    // ── 3. Block duplicate active/pending loans on the same fine ───────
    const existingLoan = await Loan.findOne({
        fineId: fine._id,
        loanStatus: { $in: ["pending", "active"] },
    });
    if (existingLoan) {
        throw new Error("An active or pending loan already exists for this ticket.");
    }

    // ── 4. Determine loan amount from settings ────────────────────
    const remainingFine = fine.totalAmountWithInterest - fine.paidAmount;
    const maxLoanAmount = await systemSettingService.getSetting("fine_loan_max_amount", 50000);
    const loanAmount = remainingFine > 0 ? Math.min(remainingFine, maxLoanAmount) : 0;

    const interestRate = await systemSettingService.getSetting("fine_loan_interest_rate", 5);
    const totalWithInterest = Math.round(loanAmount * (1 + interestRate / 100));

    const maxDurationDays = await systemSettingService.getSetting("fine_loan_max_duration_days", 90);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + maxDurationDays);

    // ── 5. Get driver’s personal loan eligibility cap from risk score ──
    let driverLoanLimit = maxLoanAmount;
    try {
        const riskScore = await riskScoringService.getRiskScore(driverId);
        driverLoanLimit = riskScore.maxLoanEligible;
    } catch (_) {
        // If risk score fails, fall back to system max
    }

    // ── 6. Create the Loan ──────────────────────────────────────
    const loan = await Loan.create({
        driverId,
        fineId: fine._id,
        tinNumber,
        ticketNumber,
        loanAmount,
        interestRate,
        totalWithInterest,
        remainingBalance: totalWithInterest,
        loanStatus: "pending",
        dueDate,
    });

    // ── 7. Return loan + driver’s limit in response ──────────────────
    return {
        loan,
        driverLoanLimit,
        systemMaxLoan: maxLoanAmount,
    };
};

/**
 * Approve a loan (admin-initiated)
 */
const approveLoan = async (loanId, adminId) => {
    const loan = await Loan.findById(loanId);
    if (!loan) throw new Error("Loan not found");
    if (loan.loanStatus !== "pending") throw new Error("Loan is not in pending status");

    loan.loanStatus = "active";
    loan.issuedAt = new Date();
    loan.approvedBy = adminId;
    await loan.save();

    // Pay off the fine with this loan
    const fine = await Fine.findById(loan.fineId);
    if (fine) {
        fine.paidAmount += loan.loanAmount;
        if (fine.paidAmount >= fine.totalAmountWithInterest) {
            fine.status = "paid";
        } else {
            fine.status = "partially_paid";
        }
        await fine.save();
    }

    // Record transaction
    await Transaction.create({
        driverId: loan.driverId,
        amount: loan.loanAmount,
        type: "fine_loan_issued",
        status: "successful",
        description: `Fine loan issued. Amount: ${loan.loanAmount} RWF. Total with interest: ${loan.totalWithInterest} RWF.`,
    });

    // Notify driver
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
    const loan = await Loan.findById(loanId);
    if (!loan) throw new Error("Loan not found");
    if (loan.loanStatus !== "pending") throw new Error("Loan is not in pending status");

    loan.loanStatus = "rejected";
    loan.approvedBy = adminId;
    await loan.save();

    return loan;
};

/**
 * Manual loan repayment from wallet
 */
const repayLoan = async (loanId, amount, driverId) => {
    const loan = await Loan.findById(loanId);
    if (!loan) throw new Error("Loan not found");
    if (loan.loanStatus !== "active") throw new Error("Loan is not active");
    if (loan.driverId.toString() !== driverId.toString()) throw new Error("Unauthorized");
    if (amount <= 0) throw new Error("Amount must be positive");

    const paymentAmount = Math.min(amount, loan.remainingBalance);

    // Debit driver wallet
    const wallet = await Wallet.findOne({ driverId });
    if (!wallet || wallet.balance < paymentAmount) {
        throw new Error(`Insufficient wallet balance. Required: ${paymentAmount} RWF`);
    }

    wallet.balance -= paymentAmount;
    await wallet.save();

    // Update loan
    loan.remainingBalance -= paymentAmount;
    if (loan.remainingBalance <= 0) {
        loan.remainingBalance = 0;
        loan.loanStatus = "successful";
        loan.completedAt = new Date();
    }
    await loan.save();

    // Record transaction
    await Transaction.create({
        driverId,
        amount: paymentAmount,
        type: "fine_loan_repayment",
        status: "successful",
        description: `Manual loan repayment. Loan remaining: ${loan.remainingBalance} RWF.`,
    });

    // Notify
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
 * Auto-deduct loan repayment from ride earnings
 * Called after each ride payment is credited
 * Returns the amount deducted (0 if no active loans)
 */
const autoDeductFromRide = async (driverId, rideEarning) => {
    const activeLoans = await Loan.find({ driverId, loanStatus: "active" }).sort({ issuedAt: 1 });
    if (activeLoans.length === 0) return 0;

    const repaymentPercentage = await systemSettingService.getSetting("fine_loan_auto_repayment_percentage", 10);
    const deductionAmount = Math.round(rideEarning * (repaymentPercentage / 100));
    if (deductionAmount <= 0) return 0;

    let totalDeducted = 0;
    let remaining = deductionAmount;

    for (const loan of activeLoans) {
        if (remaining <= 0) break;

        const payment = Math.min(remaining, loan.remainingBalance);
        loan.remainingBalance -= payment;

        if (loan.remainingBalance <= 0) {
            loan.remainingBalance = 0;
            loan.loanStatus = "successful";
            loan.completedAt = new Date();
        }
        await loan.save();

        remaining -= payment;
        totalDeducted += payment;

        // Record transaction
        await Transaction.create({
            driverId,
            amount: payment,
            type: "fine_loan_repayment",
            status: "successful",
            description: `Auto loan repayment (${repaymentPercentage}% of ride). Loan remaining: ${loan.remainingBalance} RWF.`,
        });
    }

    if (totalDeducted > 0) {
        // Debit the driver's wallet for the deduction
        const wallet = await Wallet.findOne({ driverId });
        if (wallet && wallet.balance >= totalDeducted) {
            wallet.balance -= totalDeducted;
            await wallet.save();
        }
    }

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
        { loanStatus: "active", dueDate: { $lt: now } },
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
