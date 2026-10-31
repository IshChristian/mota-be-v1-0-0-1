const service = require("../services/fuelVoucherService");

const respond = (handler) => async (req, res) => {
    try { res.status(200).json({ data: await handler(req) }); }
    catch (error) { res.status(error.statusCode || 400).json({ message: error.message }); }
};

exports.claimMoMo = respond((req) => service.claim(req.user.id, "momo", req.get("Idempotency-Key")));
exports.claimQR = respond((req) => service.claim(req.user.id, "qr", req.get("Idempotency-Key")));
exports.dailyStatus = respond((req) => service.dailyStatus(req.user.id));
exports.getVoucher = respond((req) => service.getVoucher(req.user.id, req.params.id));
exports.history = respond((req) => service.history(req.user.id, Math.max(Number(req.query.page) || 1, 1), Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)));
exports.weeklySavings = respond((req) => service.weeklySavings(req.user.id));
exports.stations = respond((req) => service.stations(Number(req.query.lat), Number(req.query.lng)));
// Drivers can't mark their own vouchers used; partner staff confirm via /api/admin/fuel-vouchers/redeem.
exports.redeem = (req, res) => res.status(403).json({ message: "Vouchers are confirmed by the partner station, not from the driver app." });
