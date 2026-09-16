const service = require("../services/fuelVoucherService");

const respond = (handler) => async (req, res) => {
    try { res.status(200).json({ data: await handler(req) }); }
    catch (error) { res.status(error.statusCode || 400).json({ message: error.message }); }
};

exports.claimMoMo = respond((req) => service.claim(req.user.id, "momo"));
exports.claimQR = respond((req) => service.claim(req.user.id, "qr"));
exports.dailyStatus = respond((req) => service.dailyStatus(req.user.id));
exports.history = respond((req) => service.history(req.user.id, Math.max(Number(req.query.page) || 1, 1), Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)));
exports.weeklySavings = respond((req) => service.weeklySavings(req.user.id));
exports.redeem = respond((req) => service.redeem(req.user.id, req.params.id));
exports.stations = (req, res) => res.status(200).json({ data: [], message: "No station directory has been configured." });
