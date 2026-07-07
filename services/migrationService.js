const MigrationStage = require("../models/MigrationStage");
const Loan = require("../models/Loan");
const Transaction = require("../models/Transaction");
const SavingsAccount = require("../models/SavingsAccount");
const auditService = require("./auditService");

/**
 * Get or create migration stage for a driver
 */
const getOrCreateMigrationStage = async (driverId) => {
    let migration = await MigrationStage.findOne({ driverId });
    if (!migration) {
        migration = await MigrationStage.create({
            driverId,
            currentStage: "fine_entry",
            stageHistory: [{ stage: "fine_entry", enteredAt: new Date(), triggerEvent: "account_created" }],
        });
    }
    return migration;
};

/**
 * Core Engine: Check and advance migration stage based on events and milestones.
 * Should be called after key events (loan repaid, transaction completed, savings deposited).
 */
const evaluateAndAdvanceStage = async (driverId, triggerEvent) => {
    const migration = await getOrCreateMigrationStage(driverId);
    let newStage = migration.currentStage;
    let milestoneUpdated = false;

    // --- Update Milestones ---

    if (triggerEvent === "loan_activated" && !migration.milestones.firstLoanActivated) {
        migration.milestones.firstLoanActivated = new Date();
        milestoneUpdated = true;
    }

    if (triggerEvent === "loan_repaid" && !migration.milestones.firstLoanRepaid) {
        migration.milestones.firstLoanRepaid = new Date();
        milestoneUpdated = true;
    }

    if (triggerEvent === "transaction_completed" && migration.milestones.firstLoanRepaid && !migration.milestones.firstTransactionAfterLoan) {
        migration.milestones.firstTransactionAfterLoan = new Date();
        milestoneUpdated = true;
    }

    if (triggerEvent === "savings_deposited" && !migration.milestones.savingsActivated) {
        migration.milestones.savingsActivated = new Date();
        milestoneUpdated = true;
    }

    // --- Evaluate 30d Activity ---
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const txCount = await Transaction.countDocuments({
        driverId,
        status: "successful",
        type: { $in: ["ride_payment", "cash_in"] },
        createdAt: { $gte: thirtyDaysAgo },
    });
    migration.milestones.transactionCount30d = txCount;
    milestoneUpdated = true;

    // Evaluate Savings 30d
    if (migration.milestones.savingsActivated && !migration.milestones.savingsHeld30d) {
        const savingsAccount = await SavingsAccount.findOne({ driverId });
        if (savingsAccount && savingsAccount.balance > 0) {
            const oldestDeposit = savingsAccount.deposits[0]?.depositedAt;
            if (oldestDeposit && (Date.now() - new Date(oldestDeposit).getTime()) > 30 * 24 * 60 * 60 * 1000) {
                migration.milestones.savingsHeld30d = new Date();
                milestoneUpdated = true;
            }
        }
    }

    // --- Stage Progression Logic ---

    if (migration.currentStage === "fine_entry") {
        if (migration.milestones.firstLoanRepaid) {
            newStage = "repayment_trust";
        }
    }

    if (migration.currentStage === "repayment_trust") {
        if (migration.milestones.firstTransactionAfterLoan && migration.milestones.transactionCount30d >= 5) {
            newStage = "transaction_adoption";
        }
    }

    if (migration.currentStage === "transaction_adoption") {
        if (migration.milestones.savingsActivated) {
            newStage = "savings_adoption";
        }
    }

    if (migration.currentStage === "savings_adoption") {
        if (migration.milestones.savingsHeld30d && migration.milestones.transactionCount30d >= 15) {
            newStage = "long_term_retention";
        }
    }

    // --- Advance Stage if changed ---
    if (newStage !== migration.currentStage) {
        // Close current stage
        const currentHistory = migration.stageHistory[migration.stageHistory.length - 1];
        if (currentHistory) {
            currentHistory.exitedAt = new Date();
        }

        // Add new stage
        migration.stageHistory.push({
            stage: newStage,
            enteredAt: new Date(),
            triggerEvent,
        });

        const oldStage = migration.currentStage;
        migration.currentStage = newStage;

        await auditService.log({
            actorId: driverId,
            actorRole: "system",
            action: "migration_stage_advanced",
            targetType: "MigrationStage",
            targetId: migration._id,
            metadata: { oldStage, newStage, triggerEvent },
        });
    }

    if (milestoneUpdated || newStage !== migration.currentStage) {
        await migration.save();
    }

    return migration;
};

/**
 * Get funnel analytics for Admin
 */
const getFunnelAnalytics = async () => {
    const stats = await MigrationStage.aggregate([
        {
            $group: {
                _id: "$currentStage",
                count: { $sum: 1 },
            },
        },
    ]);

    const funnel = {
        fine_entry: 0,
        repayment_trust: 0,
        transaction_adoption: 0,
        savings_adoption: 0,
        long_term_retention: 0,
    };

    let total = 0;
    stats.forEach(s => {
        if (funnel[s._id] !== undefined) {
            funnel[s._id] = s.count;
            total += s.count;
        }
    });

    return { funnel, total };
};

module.exports = {
    getOrCreateMigrationStage,
    evaluateAndAdvanceStage,
    getFunnelAnalytics,
};
