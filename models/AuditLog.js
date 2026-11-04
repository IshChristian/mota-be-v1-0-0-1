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
            "kyc_submitted", "kyc_reviewed", "kyc_verified", "kyc_upgraded",
            "risk_score_calculated",
            "migration_stage_advanced",
            "account_blocked", "account_unblocked",
            "user_created", "user_updated", "user_deleted", "user_role_assigned",
            "support_case_created", "support_case_updated", "support_case_deleted",
            "support_contact_logged", "support_ride_assigned", "passenger_renotified",
            "ride_admin_cancelled",
            "driver_profile_updated", "wallet_adjusted",
            "withdrawal_reviewed", "fuel_voucher_redeemed",
            "report_exported", "report_access_updated", "access_denied", "authentication_failed", "authentication_succeeded", "system_failure",
            "role_created", "role_updated", "role_deleted",
            "report_access_updated", "report_exported", "fuel_voucher_redeemed", "support_message_added",
            "registration_payment_updated", "ride_payment_updated", "kyc_fields_updated",
            "withdrawal_manual_paid", "withdrawal_returned", "withdrawal_retry",
            "access_requested", "access_request_approved", "access_request_declined", "access_request_used", "staff_permissions_updated",
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
