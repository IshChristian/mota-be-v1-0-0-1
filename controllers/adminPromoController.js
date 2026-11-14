const mongoose = require("mongoose");
const PromoCode = require("../models/PromoCode");
const PromoRedemption = require("../models/PromoRedemption");
const auditService = require("../services/auditService");
const { normalizeCode, statusOf } = require("../services/promoService");

const PAGE_SIZE = 50;
const FIELDS = ["code", "appliesTo", "discountType", "value", "maxDiscount", "minAmount", "startsAt", "endsAt", "maxUsers", "perUserLimit", "active", "note"];
const auditContext = (req) => ({ actorId: req.user.id, actorRole: req.user.role, ipAddress: req.ip });
const view = (promo) => ({ ...(promo.toObject ? promo.toObject() : promo), status: statusOf(promo) });
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const optionalNumber = (value) => (value === "" || value === null || value === undefined ? null : Number(value));
const optionalDate = (value) => (value === "" || value === null || value === undefined ? null : new Date(value));

/** Validated, normalised fields from the request (only the ones sent, for PATCH). */
const readInput = (body, current = {}) => {
    const input = {};
    for (const key of FIELDS) if (body[key] !== undefined) input[key] = body[key];
    if (input.code !== undefined) input.code = normalizeCode(input.code);
    for (const key of ["maxDiscount", "minAmount", "maxUsers"]) if (key in input) input[key] = optionalNumber(input[key]);
    for (const key of ["value", "perUserLimit"]) if (key in input) input[key] = Number(input[key]);
    for (const key of ["startsAt", "endsAt"]) if (key in input) input[key] = optionalDate(input[key]);
    if ("active" in input) input.active = input.active === true || input.active === "true";

    const merged = { ...current, ...input };
    if (!/^[A-Z0-9-]{3,20}$/.test(merged.code || "")) throw bad("Code must be 3–20 letters, numbers or dashes.");
    if (!["ride", "registration_fee"].includes(merged.appliesTo)) throw bad("Choose ride or registration fee.");
    if (!["percent", "fixed"].includes(merged.discountType)) throw bad("Choose a percentage or a fixed amount.");
    if (!Number.isFinite(merged.value) || merged.value < 1 || (merged.discountType === "percent" && merged.value > 100)) throw bad("Enter a discount between 1 and 100% or at least 1 RWF.");
    if (!Number.isInteger(merged.perUserLimit ?? 1) || (merged.perUserLimit ?? 1) < 1) throw bad("Uses per person must be at least 1.");
    if (merged.maxUsers !== null && merged.maxUsers !== undefined && (!Number.isInteger(merged.maxUsers) || merged.maxUsers < 1)) throw bad("Number of people must be at least 1, or empty for no limit.");
    for (const key of ["maxDiscount", "minAmount"]) if (merged[key] !== null && merged[key] !== undefined && (!Number.isFinite(merged[key]) || merged[key] < 0)) throw bad("Amounts must be positive numbers.");
    for (const key of ["startsAt", "endsAt"]) if (merged[key] && Number.isNaN(new Date(merged[key]).getTime())) throw bad("Enter valid dates.");
    if (merged.startsAt && merged.endsAt && new Date(merged.endsAt) <= new Date(merged.startsAt)) throw bad("The end date must be after the start date.");
    return input;
};

const fail = (res, error) => {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: "That code already exists." });
    res.status(500).json({ message: "Server error", error: error.message });
};

const list = async (req, res) => {
    try {
        const { status, appliesTo, q } = req.query;
        const filter = status === "archived" ? { archivedAt: { $ne: null } } : { archivedAt: null };
        if (["ride", "registration_fee"].includes(appliesTo)) filter.appliesTo = appliesTo;
        if (q) filter.code = { $regex: normalizeCode(q).replace(/[^A-Z0-9-]/g, ""), $options: "i" };
        let rows = (await PromoCode.find(filter).sort({ createdAt: -1 }).lean()).map(view);
        if (status && status !== "archived") rows = rows.filter((row) => row.status === status);
        res.json({ data: rows });
    } catch (error) { fail(res, error); }
};

const get = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Promo code not found." });
        const promo = await PromoCode.findById(req.params.id);
        if (!promo) return res.status(404).json({ message: "Promo code not found." });
        const page = Math.max(1, Number(req.query.page) || 1);
        const total = await PromoRedemption.countDocuments({ promoId: promo._id });
        const redemptions = await PromoRedemption.find({ promoId: promo._id }).sort({ reservedAt: -1 })
            .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).populate("userId", "firstName lastName phone role").lean();
        res.json({ data: { promo: view(promo), status: statusOf(promo), redemptions, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) } });
    } catch (error) { fail(res, error); }
};

const create = async (req, res) => {
    try {
        const input = readInput(req.body || {}, { perUserLimit: 1 });
        const promo = await PromoCode.create({ ...input, createdBy: req.user.id, updatedBy: req.user.id });
        await auditService.log({ ...auditContext(req), action: "promo_created", targetType: "PromoCode", targetId: promo._id, metadata: { after: promo.toObject() } });
        res.status(201).json({ data: view(promo) });
    } catch (error) { fail(res, error); }
};

const update = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Promo code not found." });
        const before = await PromoCode.findById(req.params.id);
        if (!before) return res.status(404).json({ message: "Promo code not found." });
        const input = readInput(req.body || {}, before.toObject());
        const used = before.reservedCount + before.redeemedCount > 0;
        if (used && ((input.code && input.code !== before.code) || (input.appliesTo && input.appliesTo !== before.appliesTo))) {
            return res.status(409).json({ message: "Code and type can't change after the code has been used." });
        }
        const promo = await PromoCode.findByIdAndUpdate(before._id, { $set: { ...input, updatedBy: req.user.id } }, { returnDocument: "after", runValidators: true });
        await auditService.log({ ...auditContext(req), action: "promo_updated", targetType: "PromoCode", targetId: promo._id, metadata: { before: before.toObject(), changes: input } });
        res.json({ data: view(promo) });
    } catch (error) { fail(res, error); }
};

/** Never used → removed. Used → archived (switched off, hidden, history kept). */
const remove = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Promo code not found." });
        const promo = await PromoCode.findById(req.params.id);
        if (!promo) return res.status(404).json({ message: "Promo code not found." });
        const everUsed = promo.reservedCount + promo.redeemedCount > 0 || await PromoRedemption.exists({ promoId: promo._id });
        if (everUsed) {
            promo.archivedAt = new Date();
            promo.active = false;
            promo.updatedBy = req.user.id;
            await promo.save();
        } else {
            await PromoCode.deleteOne({ _id: promo._id });
        }
        await auditService.log({ ...auditContext(req), action: "promo_deleted", targetType: "PromoCode", targetId: promo._id, metadata: { code: promo.code, archived: !!everUsed } });
        res.json(everUsed ? { archived: true } : { deleted: true });
    } catch (error) { fail(res, error); }
};

module.exports = { list, get, create, update, remove };
