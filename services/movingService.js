const crypto = require("crypto");
const mongoose = require("mongoose");
const MovingTruck = require("../models/MovingTruck");
const MoveRequest = require("../models/MoveRequest");
const { STATUSES, PLACE_TYPES, TRUCK_ACCESS, HOME_SIZES, TIME_WINDOWS } = MoveRequest;
const User = require("../models/User");
const Notification = require("../models/Notification");
const { effectivePermissions } = require("./reportAccess");

// MOTA Kwimuka — house moving with partner trucks. Customers book, the team quotes (after a
// free home visit when asked), the customer accepts, the team assigns a partner truck.
// Prices here are starting assumptions for the owner to confirm; staff edit them in admin.

const DEFAULT_TRUCKS = [
    { key: "pickup", name: "Pickup", model: "Toyota Hilux or similar", capacityTonnes: 1, fits: "A room or a few items", homeSizes: ["few_items"], priceMin: 25000, priceMax: 45000, perKmOutside: 600, sort: 1, photoCredit: "Photo: Chanokchon, CC BY-SA 4.0, Wikimedia Commons" },
    { key: "small", name: "Small truck", model: "Toyota Dyna / Fuso Canter (3 t)", capacityTonnes: 3, fits: "Studio or 1-bedroom home", homeSizes: ["studio", "one_bedroom"], priceMin: 50000, priceMax: 90000, perKmOutside: 900, sort: 2, photoCredit: "Photo: Gafirita jean d'amour Uwimana, CC BY-SA 4.0, Wikimedia Commons" },
    { key: "medium", name: "Medium truck", model: "Covered truck (5–7 t)", capacityTonnes: 7, fits: "2–3 bedroom home", homeSizes: ["two_bedroom", "three_bedroom"], priceMin: 100000, priceMax: 170000, perKmOutside: 1300, sort: 3, photoCredit: "Photo: Mrbobax, CC BY-SA 4.0, Wikimedia Commons" },
    { key: "large", name: "Large truck", model: "Box truck (10 t)", capacityTonnes: 10, fits: "4+ bedrooms or an office", homeSizes: ["four_plus", "office"], priceMin: 180000, priceMax: 300000, perKmOutside: 1800, sort: 4, photoCredit: "Photo: Captainmorlypogi1959, CC BY-SA 4.0, Wikimedia Commons" },
];

const EXTRAS = {
    loaderPrice: 7000, // per loader, per move
    packingPrice: 20000,
    assemblyPrice: 15000,
    stairsPricePerFloor: 2000, // per floor climbed without a lift, each end
    includedKm: 25, // inside Kigali: the truck's range covers it
    visitFee: 0, // home visits are free
    maxLoaders: 12,
};

const ITEM_KEYS = ["bed", "mattress", "sofa", "wardrobe", "table", "chairs", "fridge", "tv", "washing_machine", "cooker", "desk", "shelves", "boxes", "bags", "other_large"];
const ROAD_FACTOR = 1.3;
const ACTIVE = ["requested", "visit_scheduled", "visited", "quoted", "accepted", "confirmed", "in_progress"];
const CUSTOMER_CANCELLABLE = ["requested", "visit_scheduled", "visited", "quoted", "accepted", "confirmed"];
const MAX_ACTIVE_PER_USER = 3;

// Staff transitions. Anything else is refused so the timeline stays truthful.
const NEXT = {
    requested: ["visit_scheduled", "quoted", "cancelled"],
    visit_scheduled: ["visit_scheduled", "visited", "quoted", "cancelled"],
    visited: ["quoted", "cancelled"],
    quoted: ["quoted", "accepted", "cancelled"],
    accepted: ["quoted", "confirmed", "cancelled"],
    confirmed: ["confirmed", "in_progress", "cancelled"],
    in_progress: ["completed"],
    completed: [],
    cancelled: [],
};

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const round1000 = (n) => Math.round(n / 1000) * 1000;
const text = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function haversineKm(a, b) {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLng = rad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

async function ensureCatalog() {
    if (await MovingTruck.estimatedDocumentCount()) return;
    await Promise.all(DEFAULT_TRUCKS.map((t) => MovingTruck.updateOne({ key: t.key }, { $setOnInsert: t }, { upsert: true }).catch((e) => { if (e.code !== 11000) throw e; })));
}

async function trucks({ includeInactive = false } = {}) {
    await ensureCatalog();
    return MovingTruck.find(includeInactive ? {} : { active: true }).sort({ sort: 1, capacityTonnes: 1 }).lean();
}

async function catalog() {
    return { trucks: (await trucks()).map(publicTruck), extras: { ...EXTRAS }, itemKeys: ITEM_KEYS, homeSizes: HOME_SIZES };
}

const publicTruck = (t) => ({ key: t.key, name: t.name, model: t.model, capacityTonnes: t.capacityTonnes, fits: t.fits, homeSizes: t.homeSizes, priceMin: t.priceMin, priceMax: t.priceMax, perKmOutside: t.perKmOutside, imageUrl: t.imageUrl || "", photoCredit: t.photoCredit || "" });

function recommendKey(list, homeSize, items = []) {
    const sorted = [...list].sort((a, b) => a.capacityTonnes - b.capacityTonnes);
    let i = sorted.findIndex((t) => (t.homeSizes || []).includes(homeSize));
    if (i < 0) i = Math.max(0, sorted.length - 1);
    const count = items.reduce((n, it) => n + (Number(it.qty) || 0), 0);
    if (count > 40 && i < sorted.length - 1) i += 1; // lots of things: one size up
    return sorted[i]?.key || null;
}

function readStop(raw, label) {
    if (!raw || typeof raw !== "object") throw bad(`Add the ${label} address.`);
    const latitude = Number(raw.latitude);
    const longitude = Number(raw.longitude);
    const name = text(raw.name, 160);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw bad(`Choose the ${label} location on the map or from search.`);
    if (!PLACE_TYPES.includes(raw.placeType)) throw bad(`Say what kind of place the ${label} address is.`);
    if (!TRUCK_ACCESS.includes(raw.truckAccess)) throw bad(`Say how close a truck can park at the ${label} address.`);
    const floor = raw.floor === undefined || raw.floor === "" ? 0 : Number(raw.floor);
    if (!Number.isInteger(floor) || floor < 0 || floor > 60) throw bad(`Enter the ${label} floor as a number (0 = ground floor).`);
    return {
        name, latitude, longitude, floor,
        address: text(raw.address, 240),
        placeType: raw.placeType,
        hasElevator: raw.hasElevator === true,
        truckAccess: raw.truckAccess,
        landmark: text(raw.landmark, 240),
        contactName: text(raw.contactName, 80),
        contactPhone: text(raw.contactPhone, 20),
    };
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
function readDate(value, label, required) {
    if (value === undefined || value === null || value === "") { if (required) throw bad(`Choose the ${label}.`); return null; }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw bad(`Choose a valid ${label}.`);
    if (d < startOfToday()) throw bad(`The ${label} can't be in the past.`);
    return d;
}

/** Validated booking input (also used for estimates, where dates and contact are optional). */
function readInput(body = {}, { forEstimate = false } = {}) {
    const from = readStop(body.from, "pickup");
    const to = readStop(body.to, "destination");
    if (!HOME_SIZES.includes(body.homeSize)) throw bad("Choose the size of the home you're moving.");
    const items = (Array.isArray(body.items) ? body.items : [])
        .filter((it) => it && ITEM_KEYS.includes(it.key) && Number(it.qty) > 0)
        .map((it) => ({ key: it.key, qty: Math.min(200, Math.floor(Number(it.qty))) }));
    const loaders = body.loaders === undefined ? 2 : Number(body.loaders);
    if (!Number.isInteger(loaders) || loaders < 0 || loaders > EXTRAS.maxLoaders) throw bad(`Choose between 0 and ${EXTRAS.maxLoaders} loaders.`);
    const wantsVisit = body.wantsVisit === true;
    const truckKey = body.truckKey ? String(body.truckKey) : null;
    if (!wantsVisit && !truckKey && !forEstimate) throw bad("Choose a truck, or ask for a free home visit.");
    const input = {
        from, to, items, loaders, wantsVisit, truckKey,
        homeSize: body.homeSize,
        packing: body.packing === true,
        assembly: body.assembly === true,
    };
    if (forEstimate) return input;
    const visit = body.visit || {};
    const timeWindow = TIME_WINDOWS.includes(body.timeWindow) ? body.timeWindow : "morning";
    const photos = (Array.isArray(body.photos) ? body.photos : []).filter((u) => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 8);
    const contactPhone = text(body.contactPhone, 20);
    if (!/^\+?\d{9,13}$/.test(contactPhone.replace(/\s/g, ""))) throw bad("Enter a phone number our team can call.");
    return {
        ...input, timeWindow, photos, contactPhone,
        moveDate: readDate(body.moveDate, "moving date", !wantsVisit),
        visit: wantsVisit ? { preferredDate: readDate(visit.preferredDate, "home visit date", true), timeWindow: TIME_WINDOWS.includes(visit.timeWindow) ? visit.timeWindow : "any" } : undefined,
        notes: text(body.notes, 1000),
        source: text(body.source, 40) || "app",
        campaign: text(body.campaign, 60),
    };
}

async function estimate(input) {
    const list = await trucks();
    if (!list.length) throw bad("Moving trucks aren't available right now.", 503);
    const key = input.truckKey && list.some((t) => t.key === input.truckKey) ? input.truckKey : recommendKey(list, input.homeSize, input.items);
    if (input.truckKey && key !== input.truckKey) throw bad("That truck isn't available. Choose another one.");
    const truck = list.find((t) => t.key === key);
    const distanceKm = Math.round(haversineKm(input.from, input.to) * ROAD_FACTOR * 10) / 10;
    const extraKm = Math.max(0, distanceKm - EXTRAS.includedKm);
    const stairs = [input.from, input.to].reduce((n, s) => n + (s.hasElevator ? 0 : s.floor), 0) * EXTRAS.stairsPricePerFloor;
    const extras = input.loaders * EXTRAS.loaderPrice + (input.packing ? EXTRAS.packingPrice : 0) + (input.assembly ? EXTRAS.assemblyPrice : 0) + stairs;
    const km = extraKm * (truck.perKmOutside || 0);
    return {
        truckKey: key,
        recommendedKey: recommendKey(list, input.homeSize, input.items),
        distanceKm,
        min: round1000(truck.priceMin + extras + km),
        max: round1000(truck.priceMax + extras + km * 1.25),
        breakdown: { truckMin: truck.priceMin, truckMax: truck.priceMax, loaders: input.loaders * EXTRAS.loaderPrice, packing: input.packing ? EXTRAS.packingPrice : 0, assembly: input.assembly ? EXTRAS.assemblyPrice : 0, stairs, distance: Math.round(km) },
    };
}

async function newRef() {
    for (let i = 0; i < 5; i++) {
        const ref = `KW-${crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase()}`;
        if (!(await MoveRequest.exists({ ref }))) return ref;
    }
    throw bad("Please try again.", 503);
}

const STATUS_MESSAGES = {
    requested: (m) => ["Moving request received", `We got your move ${m.ref}. Our team will call you to confirm the details.`],
    visit_scheduled: (m) => ["Home visit booked", `Our team will visit on ${m.visit?.scheduledAt ? new Date(m.visit.scheduledAt).toLocaleString("en-GB", { timeZone: "Africa/Kigali", dateStyle: "medium", timeStyle: "short" }) : "the agreed day"} to check your things for move ${m.ref}.`],
    visited: (m) => ["Home visit done", `Thanks! We're preparing the price for move ${m.ref}.`],
    quoted: (m) => ["Your moving price is ready", `Move ${m.ref}: ${Number(m.quote?.amount || 0).toLocaleString("en-US")} RWF. Open MOTA to accept it.`],
    accepted: (m) => ["Price accepted", `We're assigning a truck to move ${m.ref}.`],
    confirmed: (m) => ["Your truck is booked", `Move ${m.ref}: ${m.partner?.plate || "truck"} with ${m.partner?.driverName || "our partner"}${m.partner?.phone ? ` (${m.partner.phone})` : ""}.`],
    in_progress: (m) => ["Your move has started", `The truck is on the way for move ${m.ref}.`],
    completed: (m) => ["Move completed", `Move ${m.ref} is done. Welcome to your new place!`],
    cancelled: (m) => ["Move cancelled", `Move ${m.ref} was cancelled.${m.cancelReason ? ` ${m.cancelReason}` : ""}`],
};

async function notifyCustomer(move) {
    const [title, message] = STATUS_MESSAGES[move.status](move);
    try {
        await Notification.create({ userId: move.userId, title, message, type: "in_app", metadata: { category: "moving", moveId: String(move._id), status: move.status } });
        require("./notificationService").sendPushNotification(move.userId, title, message, { event: "moveUpdate", moveId: String(move._id) }).catch(() => {});
    } catch (error) {
        console.error("Moving notification failed:", error.message);
    }
}

async function notifyStaff(move, title, message) {
    try {
        const staff = await User.find({ role: { $in: ["superadmin", "admin", "caller_support", "manager", "agent", "financial"] }, isActive: { $ne: false } }).select("role roleId reportPermissions permissionGrants permissionRevokes").populate("roleId", "permissions").lean();
        const recipients = staff.filter((u) => { const p = effectivePermissions(u); return p.includes("admin:access") && p.includes("support:view"); });
        await Notification.insertMany(recipients.map((u) => ({ userId: u._id, title, message, type: "in_app", metadata: { category: "moving", moveId: String(move._id), audience: "staff" } })));
        if (process.env.MOVING_OPS_PHONE) require("./smsService").sendSMS(process.env.MOVING_OPS_PHONE, `MOTA Kwimuka: ${message}`, "moving_new_request").catch(() => {});
    } catch (error) {
        console.error("Moving staff alert failed:", error.message);
    }
}

async function create(user, body) {
    const input = readInput(body);
    const active = await MoveRequest.countDocuments({ userId: user._id, status: { $in: ACTIVE } });
    if (active >= MAX_ACTIVE_PER_USER) throw bad("You already have 3 moves in progress. Finish or cancel one first.");
    const est = await estimate(input);
    const move = await MoveRequest.create({
        ...input,
        truckKey: input.truckKey || null,
        ref: await newRef(),
        userId: user._id,
        estimate: { min: est.min, max: est.max, distanceKm: est.distanceKm },
        status: "requested",
        statusHistory: [{ status: "requested", at: new Date(), by: user._id }],
    });
    void notifyCustomer(move);
    void notifyStaff(move, "New moving request", `${move.ref}: ${move.from.name} → ${move.to.name}${move.wantsVisit ? " (home visit requested)" : ""}. Call ${move.contactPhone}.`);
    return move;
}

const ownQuery = (user, id) => {
    if (!mongoose.isValidObjectId(id)) throw bad("Move not found.", 404);
    return { _id: id, userId: user._id };
};

async function listMine(user) {
    return MoveRequest.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).select("-staffNotes").lean();
}

async function getMine(user, id) {
    const move = await MoveRequest.findOne(ownQuery(user, id)).select("-staffNotes").lean();
    if (!move) throw bad("Move not found.", 404);
    return move;
}

async function cancelMine(user, id, reason) {
    const move = await MoveRequest.findOneAndUpdate(
        { ...ownQuery(user, id), status: { $in: CUSTOMER_CANCELLABLE } },
        { $set: { status: "cancelled", cancelReason: text(reason, 300) }, $push: { statusHistory: { status: "cancelled", at: new Date(), by: user._id, note: "Cancelled by customer" } } },
        { returnDocument: "after" },
    );
    if (!move) throw bad("This move can't be cancelled now. Call our team for help.", 409);
    void notifyStaff(move, "Move cancelled by customer", `${move.ref} was cancelled by the customer.`);
    return move;
}

async function acceptQuote(user, id) {
    const move = await MoveRequest.findOneAndUpdate(
        { ...ownQuery(user, id), status: "quoted", "quote.amount": { $gt: 0 } },
        { $set: { status: "accepted" }, $push: { statusHistory: { status: "accepted", at: new Date(), by: user._id } } },
        { returnDocument: "after" },
    );
    if (!move) throw bad("There's no price waiting for you to accept.", 409);
    void notifyCustomer(move);
    void notifyStaff(move, "Moving price accepted", `${move.ref} accepted ${move.quote.amount} RWF. Assign a truck.`);
    return move;
}

// ── Staff ───────────────────────────────────────────────────────────────────

async function adminList({ status, q, page = 1, limit = 30 } = {}) {
    const query = {};
    if (status === "active") query.status = { $in: ACTIVE };
    else if (STATUSES.includes(status)) query.status = status;
    if (q) {
        const safe = String(q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        query.$or = [{ ref: new RegExp(safe, "i") }, { contactPhone: new RegExp(safe) }, { "from.name": new RegExp(safe, "i") }, { "to.name": new RegExp(safe, "i") }];
    }
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 30));
    const [items, total, counts] = await Promise.all([
        MoveRequest.find(query).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).populate("userId", "firstName lastName phone").lean(),
        MoveRequest.countDocuments(query),
        MoveRequest.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    return { items, total, page: p, pages: Math.ceil(total / l), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
}

async function adminGet(id) {
    if (!mongoose.isValidObjectId(id)) throw bad("Move not found.", 404);
    const move = await MoveRequest.findById(id).populate("userId", "firstName lastName phone email").populate("statusHistory.by", "firstName lastName role").lean();
    if (!move) throw bad("Move not found.", 404);
    return move;
}

async function adminUpdate(actor, id, body = {}) {
    if (!mongoose.isValidObjectId(id)) throw bad("Move not found.", 404);
    const move = await MoveRequest.findById(id);
    if (!move) throw bad("Move not found.", 404);
    const from = move.status;
    const next = body.status && body.status !== from ? body.status : null;
    const resend = body.status && body.status === from && NEXT[from].includes(from); // e.g. a new quote or reschedule
    if (body.status && !STATUSES.includes(body.status)) throw bad("Unknown status.");
    if (next && !NEXT[from].includes(next)) throw bad(`A move that is "${from.replace("_", " ")}" can't go to "${next.replace("_", " ")}".`, 409);

    if (body.visitScheduledAt !== undefined) {
        const d = body.visitScheduledAt ? new Date(body.visitScheduledAt) : null;
        if (d && Number.isNaN(d.getTime())) throw bad("Enter a valid visit time.");
        move.visit = { ...(move.visit?.toObject?.() || move.visit || {}), scheduledAt: d };
    }
    if (body.quoteAmount !== undefined) {
        const amount = Number(body.quoteAmount);
        if (!Number.isFinite(amount) || amount <= 0) throw bad("Enter the price in RWF.");
        move.quote = { amount: Math.round(amount), note: text(body.quoteNote, 500), quotedAt: new Date(), quotedBy: actor._id };
    }
    if (body.partner && typeof body.partner === "object") {
        move.partner = { company: text(body.partner.company, 80), driverName: text(body.partner.driverName, 80), phone: text(body.partner.phone, 20), plate: text(body.partner.plate, 20).toUpperCase() };
    }
    if (body.moveDate !== undefined) {
        const d = body.moveDate ? new Date(body.moveDate) : null;
        if (d && Number.isNaN(d.getTime())) throw bad("Enter a valid moving date.");
        move.moveDate = d;
    }
    if (body.truckKey !== undefined) move.truckKey = body.truckKey ? String(body.truckKey) : null;
    if (body.staffNotes !== undefined) move.staffNotes = text(body.staffNotes, 2000);
    if (body.cancelReason !== undefined) move.cancelReason = text(body.cancelReason, 300);

    const target = next || (resend ? from : null);
    if (target === "visit_scheduled" && !move.visit?.scheduledAt) throw bad("Set the visit date and time first.");
    if (target === "quoted" && !(move.quote?.amount > 0)) throw bad("Enter the price before sending a quote.");
    if (target === "confirmed" && (!move.partner?.phone || !move.partner?.plate)) throw bad("Add the partner truck's plate and phone before confirming.");
    if (target === "confirmed" && !move.moveDate) throw bad("Set the moving date before confirming.");

    if (target) {
        move.status = target;
        move.statusHistory.push({ status: target, at: new Date(), by: actor._id, note: text(body.note, 300) });
    }
    await move.save();
    if (target) void notifyCustomer(move);
    try {
        await require("./auditService").log({ actorId: actor._id, actorRole: actor.role, action: "moving_request_updated", targetType: "MoveRequest", targetId: move._id, metadata: { from, to: move.status, ref: move.ref } });
    } catch { /* audit is best effort */ }
    return move;
}

async function adminTrucks() {
    return trucks({ includeInactive: true });
}

async function adminUpdateTruck(key, body = {}) {
    await ensureCatalog();
    const set = {};
    for (const k of ["name", "model", "fits", "imageUrl", "photoCredit"]) if (body[k] !== undefined) set[k] = text(body[k], 300);
    for (const k of ["priceMin", "priceMax", "perKmOutside", "capacityTonnes", "sort"]) if (body[k] !== undefined) {
        const n = Number(body[k]);
        if (!Number.isFinite(n) || n < 0) throw bad("Prices and sizes must be positive numbers.");
        set[k] = n;
    }
    if (body.active !== undefined) set.active = body.active === true;
    if (set.imageUrl && !/^https:\/\//.test(set.imageUrl)) throw bad("The photo link must start with https://");
    const current = await MovingTruck.findOne({ key }).lean();
    if (!current) throw bad("Truck not found.", 404);
    if ((set.priceMin ?? current.priceMin) > (set.priceMax ?? current.priceMax)) throw bad("The lowest price can't be above the highest price.");
    return MovingTruck.findOneAndUpdate({ key }, { $set: set }, { returnDocument: "after" }).lean();
}

module.exports = {
    DEFAULT_TRUCKS, EXTRAS, ITEM_KEYS, NEXT,
    catalog, readInput, estimate, recommendKey, haversineKm,
    create, listMine, getMine, cancelMine, acceptQuote,
    adminList, adminGet, adminUpdate, adminTrucks, adminUpdateTruck,
};
