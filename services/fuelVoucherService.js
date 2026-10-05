const crypto = require("crypto");
const QRCode = require("qrcode");
const mongoose = require("mongoose");
const User = require("../models/User");
const config = require("./configService");
const DAILY_LIMIT = 2,
  VOUCHER_AMOUNT = 1000;
const fail = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};
function dayWindow(now = new Date()) {
  const local = new Date(+now + 2 * 3600000);
  local.setUTCHours(0, 0, 0, 0);
  const from = new Date(+local - 2 * 3600000);
  return { from, to: new Date(+from + 86400000 - 1) };
}
async function getUser(userId) {
  const user = await User.findById(userId);
  if (!user) fail("User not found.", 404);
  if (user.role !== "driver")
    fail("Fuel support is available to drivers only.", 403);
  return user;
}
const statusOf = (voucher, now = new Date()) =>
  ["pending", "active"].includes(voucher.status) &&
  voucher.expiresAt &&
  +new Date(voucher.expiresAt) < +now
    ? "expired"
    : voucher.status;
const present = (voucher) => ({
  _id: voucher._id,
  id: voucher._id,
  qrCode: voucher.type === "qr" ? voucher.code : undefined,
  voucherId: voucher._id,
  code: voucher.code,
  type: voucher.type,
  amount: voucher.amount,
  status: statusOf(voucher),
  issuedAt: voucher.issuedAt,
  expiresAt: voucher.expiresAt,
  redeemedAt: voucher.redeemedAt,
});
async function receipt(voucher) {
  const data = present(voucher);
  if (data.type === "qr" && data.status === "active")
    data.qrImage = await QRCode.toDataURL(data.code, { width: 280, margin: 2 });
  return data;
}
async function dailyStatus(userId) {
  const user = await getUser(userId),
    { from, to } = dayWindow();
  const today = (user.fuelVouchers || []).filter(
    (v) => +new Date(v.issuedAt) >= +from && +new Date(v.issuedAt) <= +to,
  );
  return {
    momoUsed: today.filter((v) => v.type === "momo").length,
    qrUsed: today.filter((v) => v.type === "qr").length,
    momoLimit: DAILY_LIMIT,
    qrLimit: DAILY_LIMIT,
    amount: VOUCHER_AMOUNT,
    timezone: "Africa/Kigali",
    resetsAt: new Date(+to + 1),
  };
}
async function claim(userId, type, key) {
  if (!["momo", "qr"].includes(type)) fail("Choose MoMo or QR fuel support.");
  if (key && !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) fail("Invalid request key.");
  const user = await getUser(userId);
  const old =
    key && (user.fuelVouchers || []).find((v) => v.idempotencyKey === key);
  if (old) {
    if (old.type !== type)
      fail("This request key belongs to another fuel request.", 409);
    return receipt(old);
  }
  const { from, to } = dayWindow(),
    id = new mongoose.Types.ObjectId();
  const voucher = {
    _id: id,
    code: `MOTA-${type.toUpperCase()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    type,
    amount: VOUCHER_AMOUNT,
    status: type === "qr" ? "active" : "pending",
    issuedAt: new Date(),
    expiresAt: to,
    idempotencyKey: key || crypto.randomUUID(),
  };
  // Allocation and daily quota are checked in the same MongoDB update.
  const filter = {
    _id: userId,
    role: "driver",
    isActive: true,
    "fuelVouchers.idempotencyKey": { $ne: voucher.idempotencyKey },
    $expr: {
      $lt: [
        {
          $size: {
            $filter: {
              input: { $ifNull: ["$fuelVouchers", []] },
              as: "v",
              cond: {
                $and: [
                  { $eq: ["$$v.type", type] },
                  { $gte: ["$$v.issuedAt", from] },
                  { $lte: ["$$v.issuedAt", to] },
                ],
              },
            },
          },
        },
        DAILY_LIMIT,
      ],
    },
  };
  const saved = await User.findOneAndUpdate(
    filter,
    { $push: { fuelVouchers: voucher } },
    { new: true, runValidators: true },
  );
  if (!saved) {
    const current = await getUser(userId),
      existing = (current.fuelVouchers || []).find(
        (v) => v.idempotencyKey === voucher.idempotencyKey,
      );
    if (existing && existing.type === type) return receipt(existing);
    fail(
      "Daily fuel request limit reached, or the account is inactive. Refresh your fuel service screen.",
      409,
    );
  }
  return receipt(saved.fuelVouchers.find((v) => String(v._id) === String(id)));
}
async function history(userId, page = 1, limit = 20) {
  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(limit) ||
    page < 1 ||
    limit < 1 ||
    limit > 100
  )
    fail("Invalid history page.");
  const user = await getUser(userId),
    rows = [...(user.fuelVouchers || [])].sort(
      (a, b) => +new Date(b.issuedAt) - +new Date(a.issuedAt),
    );
  return {
    vouchers: rows.slice((page - 1) * limit, page * limit).map(present),
    total: rows.length,
    page,
    limit,
  };
}
async function details(userId, id) {
  if (!mongoose.isValidObjectId(id)) fail("Invalid voucher ID.");
  const user = await getUser(userId),
    voucher = user.fuelVouchers.id(id);
  if (!voucher) fail("Voucher not found.", 404);
  return receipt(voucher);
}
async function weeklySavings(userId) {
  const user = await getUser(userId),
    now = Date.now(),
    since = now - 7 * 86400000;
  // Count redemption time, not issue time, and never pending requests as savings.
  const rows = (user.fuelVouchers || []).filter(
    (v) =>
      v.status === "redeemed" &&
      v.redeemedAt &&
      +new Date(v.redeemedAt) >= since &&
      +new Date(v.redeemedAt) <= now,
  );
  const total = (type) =>
    rows
      .filter((v) => v.type === type)
      .reduce((sum, v) => sum + (Number.isFinite(v.amount) ? v.amount : 0), 0);
  return {
    weekTotal: total("momo") + total("qr"),
    momoTotal: total("momo"),
    qrTotal: total("qr"),
  };
}
async function redeem(userId, id) {
  if (!mongoose.isValidObjectId(id)) fail("Invalid voucher ID.");
  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      role: "driver",
      fuelVouchers: {
        $elemMatch: {
          _id: id,
          status: "active",
          expiresAt: { $gte: new Date() },
        },
      },
    },
    {
      $set: {
        "fuelVouchers.$.status": "redeemed",
        "fuelVouchers.$.isUsed": true,
        "fuelVouchers.$.redeemedAt": new Date(),
      },
    },
    { new: true },
  );
  if (!updated)
    fail("Voucher is expired, already redeemed or awaiting approval.", 409);
  return present(updated.fuelVouchers.id(id));
}
async function redeemCode(code) {
  if (typeof code !== "string" || !/^MOTA-QR-[A-F0-9]{12}$/.test(code))
    fail("Enter a valid MOTA QR voucher code.");
  const owner = await User.findOne({
    role: "driver",
    "fuelVouchers.code": code,
  }).select("_id fuelVouchers");
  if (!owner) fail("Voucher not found.", 404);
  const voucher = owner.fuelVouchers.find((v) => v.code === code);
  return { userId: owner._id, voucher: await redeem(owner._id, voucher._id) };
}
async function stations() {
  const rows = await config.getConfig("fuel_stations", []);
  return (Array.isArray(rows) ? rows : [])
    .filter((s) => s && s.active !== false && typeof s.name === "string")
    .slice(0, 100)
    .map((s) => ({
      id: String(s.id || s.name),
      name: s.name.slice(0, 120),
      address: String(s.address || "").slice(0, 300),
      acceptsQr: s.acceptsQr === true,
    }));
}
module.exports = {
  dayWindow,
  statusOf,
  dailyStatus,
  claim,
  history,
  details,
  weeklySavings,
  redeem,
  redeemCode,
  stations,
};
