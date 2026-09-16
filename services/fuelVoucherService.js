const crypto = require("crypto");
const User = require("../models/User");

const DAILY_LIMIT = 2;
const VOUCHER_AMOUNT = 1000;

function startOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
}

function endOfToday() {
    const date = new Date();
    date.setHours(23, 59, 59, 999);
    return date;
}

async function getUser(userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");
    if (user.role !== "driver") throw new Error("Fuel vouchers are available to drivers only");
    return user;
}

function todays(vouchers, type) {
    const since = startOfToday();
    return vouchers.filter((voucher) => voucher.type === type && voucher.issuedAt >= since);
}

async function dailyStatus(userId) {
    const user = await getUser(userId);
    return {
        momoUsed: todays(user.fuelVouchers, "momo").length,
        qrUsed: todays(user.fuelVouchers, "qr").length,
        momoLimit: DAILY_LIMIT,
        qrLimit: DAILY_LIMIT,
    };
}

async function claim(userId, type) {
    const user = await getUser(userId);
    if (todays(user.fuelVouchers, type).length >= DAILY_LIMIT) {
        const error = new Error(`Daily ${type.toUpperCase()} voucher limit reached`);
        error.statusCode = 409;
        throw error;
    }
    const code = `MOTA-${type.toUpperCase()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    const voucher = {
        code,
        type,
        amount: VOUCHER_AMOUNT,
        status: type === "qr" ? "active" : "pending",
        issuedAt: new Date(),
        expiresAt: endOfToday(),
    };
    user.fuelVouchers.push(voucher);
    await user.save();
    const saved = user.fuelVouchers[user.fuelVouchers.length - 1];
    return {
        id: saved._id,
        voucherId: saved._id,
        qrCode: type === "qr" ? code : undefined,
        code,
        type,
        amount: VOUCHER_AMOUNT,
        status: saved.status,
        expiresAt: saved.expiresAt,
    };
}

async function history(userId, page = 1, limit = 20) {
    const user = await getUser(userId);
    const vouchers = [...user.fuelVouchers].sort((a, b) => b.issuedAt - a.issuedAt);
    const start = (page - 1) * limit;
    return { vouchers: vouchers.slice(start, start + limit), total: vouchers.length, page, limit };
}

async function weeklySavings(userId) {
    const user = await getUser(userId);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const vouchers = user.fuelVouchers.filter((voucher) => voucher.issuedAt >= since && voucher.status === "redeemed");
    const momoTotal = vouchers.filter((v) => v.type === "momo").reduce((sum, v) => sum + v.amount, 0);
    const qrTotal = vouchers.filter((v) => v.type === "qr").reduce((sum, v) => sum + v.amount, 0);
    return { weekTotal: momoTotal + qrTotal, momoTotal, qrTotal };
}

async function redeem(userId, voucherId) {
    const user = await getUser(userId);
    const voucher = user.fuelVouchers.id(voucherId);
    if (!voucher) { const error = new Error("Voucher not found"); error.statusCode = 404; throw error; }
    if (voucher.status !== "active") { const error = new Error("Voucher is not active"); error.statusCode = 409; throw error; }
    if (voucher.expiresAt && voucher.expiresAt < new Date()) { voucher.status = "expired"; await user.save(); const error = new Error("Voucher expired"); error.statusCode = 409; throw error; }
    voucher.status = "redeemed";
    voucher.isUsed = true;
    voucher.redeemedAt = new Date();
    await user.save();
    return voucher;
}

module.exports = { dailyStatus, claim, history, weeklySavings, redeem };
