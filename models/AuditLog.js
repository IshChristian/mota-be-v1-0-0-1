const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
    actorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    actorRole: { type: String, trim: true },
    action: {
        type: String,
        required: true,
        enum: [
            "loan_created", "loan_approved", "loan_rejected", "loan_disbursed",
            "loan_repayment", "loan_overdue", "loan_defaulted", "loan_restructured", "loan_closed",
            "savings_deposit", "savings_withdrawal", "savings_reward",
            "admin_freeze", "admin_tier_adjust", "admin_reserve_update",
            "consent_captured", "consent_revoked",
            "kyc_verified", "kyc_upgraded",
            "risk_score_calculated",
            "migration_stage_advanced",
            "account_blocked", "account_unblocked",
            "user_created", "user_updated", "user_deleted", "user_role_assigned",
            "support_case_created", "support_case_updated", "support_case_deleted",
            "ride_admin_cancelled",
            "driver_profile_updated", "wallet_adjusted",
            "role_created", "role_updated", "role_deleted",
        ],
    },
    targetType: { type: String, trim: true },   // e.g. "Loan", "User", "SavingsAccount"
    targetId: { type: mongoose.Schema.Types.ObjectId },
    metadata: { type: mongoose.Schema.Types.Mixed },  // before/after snapshots
    ipAddress: { type: String, trim: true },
    timestamp: { type: Date, default: Date.now, index: true },
});

auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
