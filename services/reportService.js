// Admin reporting: summaries, drill-down records and investigations.
// Dates are Africa/Kigali calendar days (UTC+2, no DST); ranges are capped at 366 days.
const mongoose = require("mongoose");
const User = require("../models/User");
const Ride = require("../models/Ride");
const Transaction = require("../models/Transaction");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const Referral = require("../models/Referral");
const SupportCase = require("../models/SupportCase");
const SafetyEvent = require("../models/SafetyEvent");
const DriverKyc = require("../models/DriverKyc");
const PassengerKyc = require("../models/PassengerKyc");
const AuditLog = require("../models/AuditLog");

const KIGALI = "+02:00";
const DAY = 86400000;
const SECTION_SCOPE = {
    users: "analytics:users", rides: "analytics:rides", drivers: "analytics:rides", finance: "analytics:finance",
    withdrawals: "analytics:finance", quality: "analytics:finance", referrals: "analytics:operations", demand: "analytics:operations",
    support: "analytics:operations", documents: "analytics:operations", security: "audit:view",
};
const SECTIONS = Object.keys(SECTION_SCOPE);
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function period(query) {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
    const from = day.test(query.from || "") ? query.from : new Date(Date.now() + 2 * 3600000 - 29 * DAY).toISOString().slice(0, 10);
    const to = day.test(query.to || "") ? query.to : today;
    const start = new Date(`${from}T00:00:00${KIGALI}`);
    const end = new Date(new Date(`${to}T00:00:00${KIGALI}`).getTime() + DAY);
    if (!(start < end)) throw httpError(400, "The start date must be on or before the end date.");
    if (end - start > 366 * DAY) throw httpError(400, "Choose a period of at most 366 days.");
    return { from, to, start, end, timezone: "Africa/Kigali", previous: { start: new Date(start - (end - start)), end: start } };
}

const maskPhone = (p) => (p ? String(p).replace(/(\+?\d{3,6})\d{3}(\d{2,3})$/, "$1•••$2") : p);
const dailyGroup = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: "Africa/Kigali" } });
const toRows = (agg) => agg.map((r) => ({ _id: r._id ?? "unknown", count: r.count, ...(r.amount !== undefined ? { amount: r.amount } : {}) })).sort((a, b) => b.count - a.count);
const between = (field, p) => ({ [field]: { $gte: p.start, $lt: p.end } });
const prevBetween = (field, p) => ({ [field]: { $gte: p.previous.start, $lt: p.previous.end } });
const count = (Model, filter) => Model.countDocuments(filter);
const byField = (Model, match, field, amountField) => Model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, count: { $sum: 1 }, ...(amountField ? { amount: { $sum: { $abs: `$${amountField}` } } } : {}) } }]).then(toRows);
const daily = (Model, match, dateField) => Model.aggregate([{ $match: match }, { $group: { _id: dailyGroup(dateField), count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);

// ─── Summaries ───────────────────────────────────────────────────────────────
const summaries = {
    async users(p, prev) {
        const range = (pp) => between("createdAt", pp);
        const cards = async (pp) => ({
            "New accounts": await count(User, range(pp)),
            "New passengers": await count(User, { ...range(pp), role: "client" }),
            "New drivers": await count(User, { ...range(pp), role: "driver" }),
            "Phone verified": await count(User, { ...range(pp), isVerified: true }),
            "Total accounts now": await count(User, {}),
        });
        const cohort = { ...range(p), role: "driver" };
        return {
            cards: await cards(p),
            previousCards: prev ? await cards(p.previous) : undefined,
            funnel: {
                registered: await count(User, cohort),
                phoneVerified: await count(User, { ...cohort, isVerified: true }),
                feePaid: await count(User, { ...cohort, registrationPaid: true }),
                approved: await count(User, { ...cohort, registrationStatus: "approved" }),
                kycFull: await count(User, { ...cohort, kycLevel: "full" }),
            },
            breakdown: await byField(User, range(p), "role"),
            daily: await daily(User, range(p), "createdAt"),
            note: "Accounts created in the period, by role. The funnel follows drivers registered in the period through each verification step.",
        };
    },
    async rides(p, prev) {
        const range = (pp) => between("createdAt", pp);
        const cards = async (pp) => {
            const [all, completed, cancelled, expired, gmv] = await Promise.all([
                count(Ride, range(pp)), count(Ride, { ...range(pp), rideStatus: "completed" }), count(Ride, { ...range(pp), rideStatus: "cancelled" }),
                count(Ride, { ...range(pp), rideStatus: "expired" }),
                Ride.aggregate([{ $match: { ...range(pp), rideStatus: "completed" } }, { $group: { _id: null, sum: { $sum: "$fare" } } }]),
            ]);
            return { Requests: all, Completed: completed, Cancelled: cancelled, "No driver found": expired, "Completion rate %": all ? Math.round((completed / all) * 1000) / 10 : 0, "Completed fares (RWF)": gmv[0]?.sum || 0 };
        };
        return {
            cards: await cards(p), previousCards: prev ? await cards(p.previous) : undefined,
            breakdown: await byField(Ride, range(p), "rideStatus"),
            daily: await daily(Ride, range(p), "createdAt"),
            vehicles: await byField(Ride, range(p), "vehicleType"),
            note: "Ride requests created in the period by current status. Completion rate = completed ÷ all requests.",
        };
    },
    async drivers(p) {
        const top = await Ride.aggregate([
            { $match: { ...between("completedAt", p), rideStatus: "completed", driverId: { $ne: null } } },
            { $group: { _id: "$driverId", count: { $sum: 1 }, earnings: { $sum: { $ifNull: ["$driverEarning", 0] } }, rating: { $avg: "$passengerRating" } } },
            { $sort: { count: -1 } }, { $limit: 20 },
            { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "u" } },
        ]);
        return {
            cards: {
                "Drivers who completed rides": (await Ride.distinct("driverId", { ...between("completedAt", p), rideStatus: "completed" })).length,
                "Online now": await count(User, { role: "driver", isOnline: true }),
                "Approved drivers now": await count(User, { role: "driver", registrationStatus: "approved", isActive: true }),
            },
            breakdown: top.map((r) => ({ _id: `${r.u[0]?.firstName || ""} ${r.u[0]?.lastName || ""}`.trim() || String(r._id), count: r.count })),
            rankings: top.map((r) => ({ driver: `${r.u[0]?.firstName || ""} ${r.u[0]?.lastName || ""}`.trim(), completedRides: r.count, earningsRwf: Math.round(r.earnings), averageRating: r.rating ? Math.round(r.rating * 10) / 10 : null })),
            note: "Top 20 drivers by rides completed in the period. Earnings are after commission, before tips and fuel.",
        };
    },
    async finance(p, prev) {
        const range = (pp) => ({ ...between("createdAt", pp), status: "successful" });
        const sum = async (pp, type) => (await Transaction.aggregate([{ $match: { ...range(pp), type } }, { $group: { _id: null, s: { $sum: { $abs: "$amount" } } } }]))[0]?.s || 0;
        const cards = async (pp) => ({ "Top-ups (RWF)": await sum(pp, "cash_in"), "Withdrawals paid (RWF)": await sum(pp, "cash_out"), "Ride payments (RWF)": await sum(pp, "ride_payment"), "Commission (RWF)": await sum(pp, "commission") + await sum(pp, "platform_commission"), "Fuel support (RWF)": await sum(pp, "fuel_voucher") });
        return {
            cards: await cards(p), previousCards: prev ? await cards(p.previous) : undefined,
            breakdown: await byField(Transaction, range(p), "type", "amount"),
            daily: await daily(Transaction, range(p), "createdAt"),
            note: "Successful ledger transactions in the period by type. Amounts are absolute RWF.",
        };
    },
    async withdrawals(p) {
        const range = between("createdAt", p);
        return {
            cards: { Requests: await count(WithdrawalRequest, range), Paid: await count(WithdrawalRequest, { ...range, status: "successful" }), Failed: await count(WithdrawalRequest, { ...range, status: "failed" }), "Waiting in queue now": await count(WithdrawalRequest, { status: "queued" }) },
            breakdown: await byField(WithdrawalRequest, range, "status", "amount"),
            daily: await daily(WithdrawalRequest, range, "createdAt"),
            note: "Withdrawal requests (including MoMo fuel payouts) created in the period by status.",
        };
    },
    async referrals(p) {
        const range = between("createdAt", p);
        return {
            cards: { Referrals: await count(Referral, range), Rewarded: await count(Referral, { ...range, status: { $in: ["completed", "rewarded", "paid"] } }) },
            breakdown: await byField(Referral, range, "status"),
            daily: await daily(Referral, range, "createdAt"),
            note: "Referral records created in the period by status.",
        };
    },
    async demand(p) {
        const match = { ...between("createdAt", p), "pickup.latitude": { $type: "number" } };
        const hours = await Ride.aggregate([{ $match: match }, { $group: { _id: { $hour: { date: "$createdAt", timezone: "Africa/Kigali" } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
        // ~1 km cells; cells with fewer than 5 bookings are hidden to protect individuals.
        const cells = await Ride.aggregate([
            { $match: match },
            { $group: { _id: { lat: { $round: ["$pickup.latitude", 2] }, lng: { $round: ["$pickup.longitude", 2] } }, count: { $sum: 1 } } },
            { $match: { count: { $gte: 5 } } }, { $sort: { count: -1 } }, { $limit: 200 },
        ]);
        return {
            cards: { "Ride requests": await count(Ride, match), "Busy areas shown": cells.length },
            breakdown: hours.map((h) => ({ _id: `${String(h._id).padStart(2, "0")}:00`, count: h.count })),
            cells,
            note: "Pickups grouped into 0.01° cells (about 1 km). Cells with fewer than 5 bookings are not shown.",
        };
    },
    async support(p) {
        const range = between("createdAt", p);
        return {
            cards: { "Support cases": await count(SupportCase, range), "Open now": await count(SupportCase, { status: { $in: ["open", "in_progress"] } }), "Safety events": await count(SafetyEvent, range), "SOS events": await count(SafetyEvent, { ...range, type: "sos" }) },
            breakdown: await byField(SupportCase, range, "status"),
            categories: await byField(SupportCase, range, "category"),
            daily: await daily(SupportCase, range, "createdAt"),
            note: "Support cases and safety events created in the period.",
        };
    },
    async documents(p) {
        const range = between("updatedAt", p);
        const driver = await byField(DriverKyc, range, "status");
        const passenger = await byField(PassengerKyc, range, "status");
        return {
            cards: { "Driver KYC waiting now": await count(DriverKyc, { status: "submitted" }), "Passenger KYC waiting now": await count(PassengerKyc, { status: "submitted" }), "Driver KYC approved": await count(DriverKyc, { ...range, status: "approved" }) },
            breakdown: [...driver.map((r) => ({ ...r, _id: `driver ${r._id}` })), ...passenger.map((r) => ({ ...r, _id: `passenger ${r._id}` }))],
            note: "KYC records last updated in the period, by type and status.",
        };
    },
    async security(p) {
        const range = between("timestamp", p);
        return {
            cards: { "Audit events": await count(AuditLog, range), "Staff actors": (await AuditLog.distinct("actorId", { ...range, actorRole: { $nin: ["driver", "client", "system"] } })).length },
            breakdown: await byField(AuditLog, range, "action"),
            daily: await daily(AuditLog, range, "timestamp"),
            note: "Recorded audit events in the period by action.",
        };
    },
    async quality() {
        const dayAgo = new Date(Date.now() - DAY);
        const checks = {
            "Pending transactions older than 24h": await count(Transaction, { status: "pending", createdAt: { $lt: dayAgo } }),
            "Completed rides without a fare": await count(Ride, { rideStatus: "completed", $or: [{ fare: null }, { fare: { $lte: 0 } }] }),
            "Withdrawals stuck with provider >24h": await count(WithdrawalRequest, { status: "provider_pending", updatedAt: { $lt: dayAgo } }),
            "Drivers online with stale GPS (>15 min)": await count(User, { role: "driver", isOnline: true, lastLocationAt: { $lt: new Date(Date.now() - 15 * 60000) } }),
        };
        return {
            cards: checks,
            breakdown: Object.entries(checks).map(([k, v]) => ({ _id: k, count: v })),
            note: "Review candidates, not proven errors. Each count is a list worth checking.",
        };
    },
};

async function summary(query, perms) {
    const p = period(query);
    const requested = query.section ? [query.section] : SECTIONS;
    const sections = {};
    for (const section of requested) {
        if (!SECTION_SCOPE[section]) throw httpError(400, `Unknown report section: ${section}`);
        if (!perms.includes(SECTION_SCOPE[section])) throw httpError(403, "You don't have access to this report section.");
        sections[section] = await summaries[section](p, query.compare === "true");
    }
    return {
        generatedAt: new Date(),
        period: { from: p.from, to: p.to, timezone: p.timezone },
        coverage: ["Counts come from live records; historic events recorded before a feature existed are not inferred."],
        sections,
    };
}

// ─── Records ─────────────────────────────────────────────────────────────────
const regex = (q) => new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const name = (u) => (u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : "");

const recordQueries = {
    users: (p, q, s) => ({ Model: User, filter: { ...between("createdAt", p), ...(q.role ? { role: q.role } : {}), ...(q.q ? { $or: [{ firstName: regex(q.q) }, { lastName: regex(q.q) }, { phone: regex(q.q) }] } : {}) }, sort: { createdAt: -1 }, select: "firstName lastName phone role registrationStatus isVerified isActive kycLevel createdAt", map: (u) => ({ name: name(u), phone: s ? u.phone : maskPhone(u.phone), role: u.role, registration: u.registrationStatus, phoneVerified: u.isVerified, active: u.isActive, kyc: u.kycLevel, created: u.createdAt }) }),
    rides: (p, q) => ({ Model: Ride, filter: { ...between("createdAt", p), ...(q.status ? { rideStatus: q.status } : {}) }, sort: { createdAt: -1 }, select: "rideStatus vehicleType rideType fare paymentMethod paymentStatus pickup.name destination.name estimatedDistanceKm createdAt", map: (r) => ({ id: r._id, status: r.rideStatus, vehicle: r.vehicleType, type: r.rideType, fareRwf: r.fare, payment: `${r.paymentMethod || ""} ${r.paymentStatus || ""}`.trim(), from: r.pickup?.name, to: r.destination?.name, km: r.estimatedDistanceKm, created: r.createdAt }) }),
    drivers: (p, q) => ({ Model: User, filter: { role: "driver", ...(q.q ? { $or: [{ firstName: regex(q.q) }, { lastName: regex(q.q) }] } : {}) }, sort: { createdAt: -1 }, select: "firstName lastName registrationStatus isOnline isActive lastLocationAt createdAt", map: (u) => ({ id: u._id, name: name(u), registration: u.registrationStatus, online: u.isOnline, active: u.isActive, lastGps: u.lastLocationAt, joined: u.createdAt }) }),
    finance: (p, q) => ({ Model: Transaction, filter: { ...between("createdAt", p), ...(q.status ? { status: q.status } : {}), ...(q.q ? { type: q.q } : {}) }, sort: { createdAt: -1 }, select: "type amount status paypackRef description createdAt", map: (t) => ({ type: t.type, amountRwf: t.amount, status: t.status, reference: t.paypackRef, description: t.description, created: t.createdAt }) }),
    withdrawals: (p, q, s) => ({ Model: WithdrawalRequest, filter: { ...between("createdAt", p), ...(q.status ? { status: q.status } : {}) }, sort: { createdAt: -1 }, select: "amount fee status phone paypackRef failureReason createdAt", map: (w) => ({ amountRwf: w.amount, feeRwf: w.fee, status: w.status, phone: s ? w.phone : maskPhone(w.phone), reference: w.paypackRef, failure: w.failureReason, created: w.createdAt }) }),
    referrals: (p, q) => ({ Model: Referral, filter: { ...between("createdAt", p), ...(q.status ? { status: q.status } : {}) }, sort: { createdAt: -1 }, select: "status reward createdAt", map: (r) => ({ status: r.status, rewardRwf: r.reward, created: r.createdAt }) }),
    demand: (p) => ({ Model: Ride, filter: between("createdAt", p), sort: { createdAt: -1 }, select: "pickup.latitude pickup.longitude rideStatus createdAt", map: (r) => ({ areaLat: r.pickup?.latitude != null ? Math.round(r.pickup.latitude * 100) / 100 : null, areaLng: r.pickup?.longitude != null ? Math.round(r.pickup.longitude * 100) / 100 : null, status: r.rideStatus, created: r.createdAt }) }),
    support: (p, q, s) => ({ Model: SupportCase, filter: { ...between("createdAt", p), ...(q.status ? { status: q.status } : {}) }, sort: { createdAt: -1 }, select: "subject category priority status createdAt description", map: (c) => ({ id: c._id, subject: c.subject, category: c.category, priority: c.priority, status: c.status, description: s ? c.description : undefined, created: c.createdAt }) }),
    documents: (p, q) => ({ Model: DriverKyc, filter: { ...between("updatedAt", p), ...(q.status ? { status: q.status } : {}) }, sort: { updatedAt: -1 }, select: "status vehicleType plateNumber submittedAt reviewedAt updatedAt", map: (k) => ({ status: k.status, vehicle: k.vehicleType, plate: k.plateNumber, submitted: k.submittedAt, reviewed: k.reviewedAt }) }),
    security: (p, q, s) => ({ Model: AuditLog, filter: { ...between("timestamp", p), ...(q.action ? { action: q.action } : {}), ...(q.actorId && mongoose.isValidObjectId(q.actorId) ? { actorId: q.actorId } : {}), ...(q.targetId && mongoose.isValidObjectId(q.targetId) ? { targetId: q.targetId } : {}), ...(q.targetType ? { targetType: q.targetType } : {}), ...(q.q ? { action: regex(q.q) } : {}) }, sort: { timestamp: -1 }, select: "action actorId actorRole targetType targetId metadata ipAddress timestamp", map: (a) => ({ _id: a._id, timestamp: a.timestamp, action: a.action, actorId: a.actorId, actorRole: a.actorRole, targetType: a.targetType, targetId: a.targetId, ipAddress: s ? a.ipAddress : undefined, metadata: s ? redactSecrets(a.metadata) : summarizeMetadata(a.metadata) }) }),
    quality: () => ({ Model: Transaction, filter: { status: "pending", createdAt: { $lt: new Date(Date.now() - DAY) } }, sort: { createdAt: 1 }, select: "type amount paypackRef createdAt", map: (t) => ({ check: "Pending transaction older than 24h", type: t.type, amountRwf: t.amount, reference: t.paypackRef, created: t.createdAt }) }),
};

const SECRET = /pass|token|secret|otp|pin|key/i;
function redactSecrets(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(redactSecrets);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? "[redacted]" : redactSecrets(v)]));
}
/** Without audit:sensitive: keep structure (which fields changed), hide values. */
function summarizeMetadata(value) {
    if (!value || typeof value !== "object") return value == null ? value : "[restricted]";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? summarizeMetadata(v) : typeof v === "number" || typeof v === "boolean" ? v : "[restricted]"]));
}

async function records(section, query, perms, { limit = 25, max } = {}) {
    if (!SECTION_SCOPE[section]) throw httpError(400, `Unknown report section: ${section}`);
    if (!perms.includes(SECTION_SCOPE[section])) throw httpError(403, "You don't have access to this report section.");
    const p = period(query);
    const sensitive = perms.includes("audit:sensitive");
    const { Model, filter, sort, select, map } = recordQueries[section](p, query, sensitive);
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const size = max || Math.min(100, limit);
    const [docs, total] = await Promise.all([Model.find(filter).sort(sort).skip(max ? 0 : (page - 1) * size).limit(size).select(select).lean(), Model.countDocuments(filter)]);
    return {
        rows: docs.map(map),
        total,
        page,
        pages: Math.max(1, Math.ceil(total / size)),
        note: sensitive ? "Showing full personal details (audit:sensitive)." : "Phone numbers, IP addresses and free text are restricted in your view.",
    };
}

/** Everything linked to one record: its audit timeline plus related rides/transactions the viewer may see. */
async function investigate(type, id, query, perms) {
    if (!mongoose.isValidObjectId(id)) throw httpError(400, "Enter a valid record ID.");
    const p = period(query);
    const sensitive = perms.includes("audit:sensitive");
    const timeline = (await AuditLog.find({ $or: [{ targetId: id }, { actorId: id }], ...between("timestamp", p) }).sort({ timestamp: -1 }).limit(200).lean())
        .map((a) => ({ ...a, ipAddress: sensitive ? a.ipAddress : undefined, metadata: sensitive ? redactSecrets(a.metadata) : summarizeMetadata(a.metadata) }));
    const result = { timeline };
    if (type === "User" && perms.includes("analytics:rides")) {
        result.rides = (await Ride.find({ $or: [{ passengerId: id }, { driverId: id }], ...between("createdAt", p) }).sort({ createdAt: -1 }).limit(100).select("rideStatus fare paymentMethod createdAt").lean())
            .map((r) => ({ id: r._id, status: r.rideStatus, fareRwf: r.fare, payment: r.paymentMethod, created: r.createdAt }));
    }
    if (type === "User" && perms.includes("analytics:finance")) {
        result.transactions = (await Transaction.find({ driverId: id, ...between("createdAt", p) }).sort({ createdAt: -1 }).limit(100).select("type amount status createdAt").lean())
            .map((t) => ({ type: t.type, amountRwf: t.amount, status: t.status, created: t.createdAt }));
    }
    return result;
}

module.exports = { SECTIONS, SECTION_SCOPE, period, summary, records, investigate };
