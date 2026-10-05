const service = require("../services/fuelVoucherService");

const respond = (handler) => async (req, res) => {
  try {
    res.status(200).json({ data: await handler(req) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.claimMoMo = respond((req) =>
  service.claim(req.user.id, "momo", req.get("Idempotency-Key")),
);
exports.claimQR = respond((req) =>
  service.claim(req.user.id, "qr", req.get("Idempotency-Key")),
);
exports.dailyStatus = respond((req) => service.dailyStatus(req.user.id));
exports.history = respond((req) =>
  service.history(
    req.user.id,
    Math.max(Number(req.query.page) || 1, 1),
    Math.min(Math.max(Number(req.query.limit) || 20, 1), 100),
  ),
);
exports.weeklySavings = respond((req) => service.weeklySavings(req.user.id));
exports.redeem = respond(async (req) => {
  const voucher = await service.redeem(req.params.userId, req.params.id);
  await require("../services/auditService").log({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: "fuel_voucher_redeemed",
    targetType: "User",
    targetId: req.params.userId,
    ipAddress: req.ip,
    metadata: {
      voucherId: req.params.id,
      amount: voucher.amount,
      type: voucher.type,
    },
  });
  return voucher;
});
exports.stations = respond(() => service.stations());
exports.details = respond((req) => service.details(req.user.id, req.params.id));

exports.redeemCode = respond(async (req) => {
  const { userId, voucher } = await service.redeemCode(req.body.code);
  await require("../services/auditService").log({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: "fuel_voucher_redeemed",
    targetType: "User",
    targetId: userId,
    ipAddress: req.ip,
    metadata: {
      voucherId: voucher.id,
      amount: voucher.amount,
      type: voucher.type,
    },
  });
  return voucher;
});
