const RepaymentSchedule = require("../models/RepaymentSchedule");
const Loan = require("../models/Loan");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const User = require("../models/User");
const auditService = require("./auditService");
const { sendSMS } = require("./smsService");

/**
 * Generate a repayment schedule for a loan.
 * Max repayment term: 3 months (90 days).
 * @param {string} loanId
 * @param {string} frequency - "daily", "weekly", or "monthly"
 */
const generateSchedule = async (loanId, frequency = "monthly") => {
    const loan = await Loan.findById(loanId);
    if (!loan) throw new Error("Loan not found");

    // Max 3 months = 90 days
    const maxDays = 90;
    let totalInstallments;
    let intervalDays;

    switch (frequency) {
        case "daily":
            totalInstallments = maxDays;
            intervalDays = 1;
            break;
        case "weekly":
            totalInstallments = Math.ceil(maxDays / 7); // ~13 weeks
            intervalDays = 7;
            break;
        case "monthly":
        default:
            totalInstallments = 3;
            intervalDays = 30;
            break;
    }

    const installmentAmount = Math.ceil(loan.totalWithInterest / totalInstallments);
    const installments = [];
    const startDate = loan.issuedAt || new Date();

    for (let i = 1; i <= totalInstallments; i++) {
        const dueDate = new Date(startDate);
        dueDate.setDate(dueDate.getDate() + (intervalDays * i));

        // Last installment absorbs rounding remainder
        const amount = i === totalInstallments
            ? loan.totalWithInterest - (installmentAmount * (totalInstallments - 1))
            : installmentAmount;

        installments.push({
            installmentNumber: i,
            dueDate,
            amount: Math.max(0, amount),
            paidAmount: 0,
            status: "upcoming",
        });
    }

    const schedule = await RepaymentSchedule.findOneAndUpdate(
        { loanId },
        {
            loanId,
            driverId: loan.driverId,
            installments,
            frequency,
            totalInstallments,
        },
        { upsert: true, new: true }
    );

    return schedule;
};

/**
 * Get the repayment schedule for a loan
 */
const getSchedule = async (loanId) => {
    return await RepaymentSchedule.findOne({ loanId })
        .populate("installments.transactionId", "amount status createdAt");
};

/**
 * Record a repayment against the next due installment
 * @param {string} loanId
 * @param {number} amount
 * @param {string} transactionId - Optional transaction ref
 */
const recordRepayment = async (loanId, amount, transactionId = null) => {
    const schedule = await RepaymentSchedule.findOne({ loanId });
    if (!schedule) return null; // No schedule = old-style loan, skip

    let remaining = amount;

    for (const inst of schedule.installments) {
        if (remaining <= 0) break;
        if (inst.status === "paid" || inst.status === "waived") continue;

        const owed = inst.amount - inst.paidAmount;
        if (owed <= 0) continue;

        const payment = Math.min(remaining, owed);
        inst.paidAmount += payment;
        remaining -= payment;

        if (inst.paidAmount >= inst.amount) {
            inst.status = "paid";
            inst.paidAt = new Date();
        } else {
            inst.status = "partial";
        }

        if (transactionId) inst.transactionId = transactionId;
    }

    await schedule.save();
    return schedule;
};

/**
 * Check for overdue installments and update loan status.
 * Called by cronService every hour.
 */
const checkOverdueInstallments = async () => {
    const now = new Date();
    let overdueCount = 0;

    // Find all schedules with upcoming/partial installments past due date
    const schedules = await RepaymentSchedule.find({
        "installments": {
            $elemMatch: {
                status: { $in: ["upcoming", "partial"] },
                dueDate: { $lt: now },
            },
        },
    }).populate("loanId");

    for (const schedule of schedules) {
        let hasOverdue = false;

        for (const inst of schedule.installments) {
            if (["upcoming", "partial"].includes(inst.status) && inst.dueDate < now) {
                inst.status = "overdue";
                hasOverdue = true;
            }
        }

        if (hasOverdue) {
            await schedule.save();

            // Move loan to overdue if it's currently active
            const loan = schedule.loanId;
            if (loan && loan.loanStatus === "active") {
                loan.loanStatus = "overdue";
                await loan.save();
                overdueCount++;

                await auditService.log({
                    actorRole: "system",
                    action: "loan_overdue",
                    targetType: "Loan",
                    targetId: loan._id,
                    metadata: { reason: "Missed installment(s)" },
                });

                // SMS reminder
                const driver = await User.findById(loan.driverId);
                if (driver) {
                    await sendSMS(
                        driver.phone,
                        `MOTA: Your loan repayment is overdue. Remaining: ${loan.remainingBalance} RWF. Please repay to avoid penalties and restore borrowing access.`,
                        "loan_overdue"
                    );
                }
            }
        }
    }

    return overdueCount;
};

/**
 * Send upcoming payment reminders (1 day before due date).
 * Called by cronService daily.
 */
const sendUpcomingReminders = async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 59, 999);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const schedules = await RepaymentSchedule.find({
        "installments": {
            $elemMatch: {
                status: "upcoming",
                dueDate: { $gte: today, $lte: tomorrow },
            },
        },
    });

    let reminderCount = 0;

    for (const schedule of schedules) {
        const dueInstallment = schedule.installments.find(
            i => i.status === "upcoming" && i.dueDate >= today && i.dueDate <= tomorrow
        );

        if (dueInstallment) {
            const driver = await User.findById(schedule.driverId);
            if (driver) {
                await sendSMS(
                    driver.phone,
                    `MOTA Reminder: Your loan installment of ${dueInstallment.amount} RWF is due tomorrow. Ensure your wallet has sufficient funds for auto-deduction.`,
                    "loan_reminder"
                );
                reminderCount++;
            }
        }
    }

    return reminderCount;
};

module.exports = {
    generateSchedule,
    getSchedule,
    recordRepayment,
    checkOverdueInstallments,
    sendUpcomingReminders,
};
