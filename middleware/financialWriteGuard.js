/**
 * Release gate for balance-changing endpoints.
 *
 * The current financial services do not consistently use MongoDB transactions
 * and idempotency records. Keep writes closed in production until that migration
 * is complete and tested on a replica set (transactions require one).
 */
module.exports = function financialWriteGuard(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.path.includes("webhook") || req.path.includes("callback")) return next();
    if (process.env.FINANCIAL_WRITES_ENABLED === "true") return next();
    return res.status(503).json({
        code: "FINANCIAL_WRITES_DISABLED",
        message: "Money-changing operations are temporarily disabled while transactional ledger safeguards are being completed.",
    });
};
