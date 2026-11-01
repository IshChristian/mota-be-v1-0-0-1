// Fuel support for drivers.
//
// Rules (admin-configurable in system settings):
//   fuel_voucher_amount       value of one voucher (RWF)
//   fuel_voucher_daily_limit  requests per type per Kigali day
//   fuel_voucher_min_tier     lowest tier allowed (tier engine unlocks "fuel_voucher" at Gold)
//   fuel_voucher_momo_enabled MoMo vouchers on/off
//   fuel_stations             JSON list of partner stations
//
// QR vouchers: shown at a partner station; only staff can mark them redeemed.
// MoMo vouchers: funded by MOTA and paid through the same withdrawal pipeline
// as wallet cash-outs (held funds, per-user queue up to the provider minimum,
// signed webhook settlement). A failed payout lands in the driver's wallet.
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const DriverKyc = require("../models/DriverKyc");
const RiderAlgorithm = require("../models/RiderAlgorithm");
const systemSettingService = require("./systemSettingService");

const TIERS = ["Bronze", "Silver", "Gold", "Platinum"];
const KIGALI_OFFSET_MS = 2 * 3600 * 1000; // Rwanda is UTC+2 all year
const DAY_MS = 86400000;

const httpError = (statusCode, message, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const kigaliDayStart = (now = Date.now()) => new Date(Math.floor((now + KIGALI_OFFSET_MS) / DAY_MS) * DAY_MS - KIGALI_OFFSET_MS);
const kigaliMidnight = (now = Date.now()) => new Date(kigaliDayStart(now).getTime() + DAY_MS - 1);

async function rules() {
    const get = (key, fallback) => systemSettingService.getSetting(key, fallback);
    const [amount, dailyLimit, minTier, momoEnabled] = await Promise.all([
        get("fuel_voucher_amount", 1000), get("fuel_voucher_daily_limit", 2), get("fuel_voucher_min_tier", "Gold"), get("fuel_voucher_momo_enabled", true),
    ]);
    return {
        amount: Math.max(100, Math.round(Number(amount) || 1000)),
        dailyLimit: Math.max(0, Math.round(Number(dailyLimit) || 0)),
        minTier: TIERS.includes(minTier) ? minTier : "Gold",
        momoEnabled: momoEnabled === true || momoEnabled === "true",
    };
}

/** Who may request fuel support, and why not when they can't. */
async function eligibility(user, r) {
    if (!user || user.role !== "driver") return { eligible: false, reason: "Fuel support is for MOTA drivers." };
    if (!user.isActive || user.registrationStatus !== "approved") return { eligible: false, reason: "Your driver account must be approved first." };
    const kyc = await DriverKyc.exists({ userId: user._id, status: "approved" });
    if (!kyc) return { eligible: false, reason: "Your driver documents must be approved first." };
    const rider = await RiderAlgorithm.findOne({ riderId: user._id }).select("current_tier features_unlocked").lean();
    const tier = rider?.current_tier || "Bronze";
    const unlocked = (rider?.features_unlocked || []).includes("fuel_voucher") || TIERS.indexOf(tier) >= TIERS.indexOf(r.minTier);
    if (!unlocked) return { eligible: false, tier, reason: `Fuel vouchers unlock at ${r.minTier} tier. You are ${tier}. Complete more rides to level up.` };
    return { eligible: true, tier };
}

const todaysRequests = (vouchers, type) => {
    const since = kigaliDayStart();
    return (vouchers || []).filter((v) => v.type === type && (v.source || "request") === "request" && v.issuedAt >= since);
};

const MOMO_STATUS = { queued: "queued", processing: "sending", provider_pending: "sending", successful: "paid", failed: "returned" };

function view(v, withdrawal) {
    const expired = v.type === "qr" && v.status === "active" && v.expiresAt && v.expiresAt < new Date();
    let status = expired ? "expired" : v.status;
    let note;
    if (v.type === "momo") {
        status = MOMO_STATUS[withdrawal?.status] || v.status;
        note = status === "queued" ? "Queued. MoMo payouts are sent once your pending payouts reach the provider minimum."
            : status === "sending" ? "Sending to your MoMo number."
            : status === "paid" ? "Paid to your MoMo number."
            : status === "returned" ? "The MoMo payout failed, so the amount was added to your MOTA wallet." : undefined;
    }
    return {
        id: String(v._id),
        code: v.code,
        type: v.type,
        source: v.source || "request",
        amount: v.amount,
        status,
        note,
        qrCode: v.type === "qr" ? v.code : undefined,
        issuedAt: v.issuedAt,
        expiresAt: v.expiresAt,
        redeemedAt: v.redeemedAt,
        station: v.station,
    };
}

async function withdrawalsFor(vouchers) {
    const ids = vouchers.map((v) => v.withdrawalRequestId).filter(Boolean);
    if (!ids.length) return new Map();
    const rows = await WithdrawalRequest.find({ _id: { $in: ids } }).select("status").lean();
    return new Map(rows.map((w) => [String(w._id), w]));
}

async function dailyStatus(userId) {
    const r = await rules();
    const user = await User.findById(userId);
    const elig = await eligibility(user, r);
    return {
        ...elig,
        minTier: r.minTier,
        amount: r.amount,
        momoEnabled: r.momoEnabled,
        qrUsed: todaysRequests(user?.fuelVouchers, "qr").length,
        momoUsed: todaysRequests(user?.fuelVouchers, "momo").length,
        qrLimit: r.dailyLimit,
        momoLimit: r.momoEnabled ? r.dailyLimit : 0,
        resetsAt: kigaliMidnight(),
    };
}

async function claim(userId, type, idempotencyKey) {
    const key = String(idempotencyKey || "").trim();
    if (key.length < 8 || key.length > 120) throw httpError(400, "Idempotency-Key header is required.");
    const r = await rules();
    if (type === "momo" && !r.momoEnabled) throw httpError(403, "MoMo fuel vouchers are currently turned off. Use a QR voucher at a partner station.");

    // Replays return the original voucher.
    const prior = await User.findOne({ _id: userId, "fuelVouchers.idempotencyKey": key }).select("fuelVouchers");
    if (prior) {
        const v = prior.fuelVouchers.find((x) => x.idempotencyKey === key);
        return view(v, (await withdrawalsFor([v])).get(String(v.withdrawalRequestId)));
    }

    let created;
    let phone;
    // One transaction: limit check + voucher (+ payout reservation). Concurrent
    // requests write the same user document, so one retries and sees the other.
    await mongoose.connection.transaction(async (session) => {
        const user = await User.findById(userId).session(session);
        const elig = await eligibility(user, r);
        if (!elig.eligible) throw httpError(403, elig.reason);
        if (todaysRequests(user.fuelVouchers, type).length >= r.dailyLimit) {
            throw httpError(409, `You've used today's ${type === "qr" ? "QR" : "MoMo"} vouchers. They reset at midnight Kigali time.`);
        }
        phone = user.phone;
        const voucher = {
            code: `MOTA-${type.toUpperCase()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
            type,
            source: "request",
            amount: r.amount,
            status: type === "qr" ? "active" : "processing",
            issuedAt: new Date(),
            expiresAt: type === "qr" ? kigaliMidnight() : undefined,
            idempotencyKey: key,
        };
        user.fuelVouchers.push(voucher);
        const saved = user.fuelVouchers[user.fuelVouchers.length - 1];

        if (type === "momo") {
            // MOTA funds the voucher, then it is reserved exactly like a wallet withdrawal (no fee).
            await Wallet.updateOne({ driverId: userId }, { $inc: { heldBalance: r.amount }, $setOnInsert: { driverId: userId, balance: 0 } }, { upsert: true, session });
            const [request] = await WithdrawalRequest.create([{
                driverId: userId, amount: r.amount, fee: 0, totalHeld: r.amount, phone: user.phone, idempotencyKey: `fuel:${saved._id}`,
            }], { session });
            saved.withdrawalRequestId = request._id;
            await Transaction.create([
                { driverId: userId, amount: r.amount, type: "fuel_voucher", status: "successful", reference: String(saved._id), description: `MOTA fuel support ${saved.code}` },
                { driverId: userId, amount: -r.amount, feeAmount: 0, type: "cash_out", status: "pending", reference: request._id.toString(), idempotencyKey: `fuel:${saved._id}`, senderPhone: "MOTA", receiverPhone: user.phone, description: `Fuel voucher payout ${saved.code}` },
            ], { session, ordered: true });
        }
        await user.save({ session });
        created = saved;
    });

    if (type === "momo") {
        // Same dispatch as withdrawals: sends once queued payouts reach the provider minimum.
        try { await require("./withdrawalService").dispatchQueued(String(userId), phone); }
        catch (error) { console.error("Fuel payout dispatch deferred:", error.message); }
    }
    const fresh = (await User.findById(userId).select("fuelVouchers")).fuelVouchers.id(created._id);
    return view(fresh, (await withdrawalsFor([fresh])).get(String(fresh.withdrawalRequestId)));
}

async function getVoucher(userId, voucherId) {
    if (!mongoose.isValidObjectId(voucherId)) throw httpError(404, "Voucher not found.");
    const user = await User.findById(userId).select("fuelVouchers");
    const v = user?.fuelVouchers.id(voucherId);
    if (!v) throw httpError(404, "Voucher not found.");
    return view(v, (await withdrawalsFor([v])).get(String(v.withdrawalRequestId)));
}

async function history(userId, page = 1, limit = 20) {
    const user = await User.findById(userId).select("fuelVouchers");
    const all = [...(user?.fuelVouchers || [])].sort((a, b) => b.issuedAt - a.issuedAt);
    const slice = all.slice((page - 1) * limit, page * limit);
    const w = await withdrawalsFor(slice);
    return { vouchers: slice.map((v) => view(v, w.get(String(v.withdrawalRequestId)))), total: all.length, page, limit };
}

async function weeklySavings(userId) {
    const user = await User.findById(userId).select("fuelVouchers");
    const since = new Date(Date.now() - 7 * DAY_MS);
    const recent = (user?.fuelVouchers || []).filter((v) => v.issuedAt >= since);
    const w = await withdrawalsFor(recent);
    const settled = recent.map((v) => view(v, w.get(String(v.withdrawalRequestId)))).filter((v) => v.status === "redeemed" || v.status === "paid" || v.status === "returned");
    const momoTotal = settled.filter((v) => v.type === "momo").reduce((s, v) => s + v.amount, 0);
    const qrTotal = settled.filter((v) => v.type === "qr").reduce((s, v) => s + v.amount, 0);
    return { weekTotal: momoTotal + qrTotal, momoTotal, qrTotal };
}

/** Staff at a partner station confirm a QR voucher by its code. */
async function redeemByCode(code, staffId, station) {
    const clean = String(code || "").trim().toUpperCase();
    if (!clean) throw httpError(400, "Voucher code is required.");
    const now = new Date();
    const user = await User.findOneAndUpdate(
        { fuelVouchers: { $elemMatch: { code: clean, type: "qr", status: "active", $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] } } },
        { $set: { "fuelVouchers.$.status": "redeemed", "fuelVouchers.$.isUsed": true, "fuelVouchers.$.redeemedAt": now, "fuelVouchers.$.redeemedBy": staffId, "fuelVouchers.$.station": station ? String(station).slice(0, 120) : undefined } },
        { returnDocument: "after" }
    ).select("firstName lastName phone fuelVouchers");
    if (!user) {
        const owner = await User.findOne({ "fuelVouchers.code": clean }).select("fuelVouchers");
        const v = owner?.fuelVouchers.find((x) => x.code === clean);
        if (!v) throw httpError(404, "No voucher has this code.");
        if (v.status === "redeemed") throw httpError(409, `Already redeemed on ${v.redeemedAt?.toISOString()}.`);
        throw httpError(409, v.type !== "qr" ? "MoMo vouchers are paid to the phone, not redeemed at stations." : "This voucher has expired.");
    }
    try { await require("./algorithmService").recordFuelVoucherUsed(user._id); } catch { /* stats only */ }
    const v = user.fuelVouchers.find((x) => x.code === clean);
    return { voucher: view(v), driver: { id: user._id, name: `${user.firstName} ${user.lastName}`, phone: user.phone } };
}

async function stations(lat, lng) {
    // Stored as a JSON string (admin Fuel page) or as a list (older setting format).
    let list = [];
    const raw = await systemSettingService.getSetting("fuel_stations", "[]");
    try { list = Array.isArray(raw) ? raw : JSON.parse(raw); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const valid = list.filter((s) => s && s.name && s.active !== false && s.isActive !== false).map((s, i) => ({ id: String(s.id || i), name: s.name, address: s.address || "", latitude: Number(s.latitude), longitude: Number(s.longitude), acceptsQr: s.acceptsQr !== false }));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return valid;
    const { haversine } = require("./rideEngineService");
    return valid.map((s) => ({ ...s, distanceKm: Number.isFinite(s.latitude) ? Math.round(haversine(lat, lng, s.latitude, s.longitude) * 10) / 10 : null }))
        .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
}

module.exports = { dailyStatus, claim, getVoucher, history, weeklySavings, redeemByCode, stations, kigaliDayStart, kigaliMidnight };
