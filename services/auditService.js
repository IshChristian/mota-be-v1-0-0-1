const AuditLog = require("../models/AuditLog");

/**
 * Log an auditable event
 * @param {Object} params
 * @param {string} params.actorId - User performing the action
 * @param {string} params.actorRole - Role of the actor
 * @param {string} params.action - Action enum value
 * @param {string} params.targetType - Model name (e.g. "Loan")
 * @param {string} params.targetId - Document ID
 * @param {Object} params.metadata - Additional context (before/after)
 * @param {string} params.ipAddress - Request IP
 */
const log = async ({ actorId, actorRole, action, targetType, targetId, metadata, ipAddress }) => {
    try {
        await AuditLog.create({
            actorId,
            actorRole: actorRole || "system",
            action,
            targetType,
            targetId,
            metadata,
            ipAddress,
        });
    } catch (err) {
        // Audit logging should never crash the application
        console.error("[AuditLog] Failed to write:", err.message);
    }
};

/**
 * Query audit logs with filters
 */
const query = async (filters = {}, page = 1, limit = 50) => {
    const query = {};
    if (filters.actorId) query.actorId = filters.actorId;
    if (filters.action) query.action = filters.action;
    if (filters.targetType) query.targetType = filters.targetType;
    if (filters.targetId) query.targetId = filters.targetId;
    if (filters.from || filters.to) {
        query.timestamp = {};
        if (filters.from) query.timestamp.$gte = new Date(filters.from);
        if (filters.to) query.timestamp.$lte = new Date(filters.to);
    }

    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
        AuditLog.find(query)
            .populate("actorId", "firstName lastName phone role")
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(limit),
        AuditLog.countDocuments(query),
    ]);

    return { logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

module.exports = { log, query };
