// Support conversations shared by the mobile help center (/api/support) and the
// admin panel (/api/admin/support-cases/:id/messages). Internal notes stay staff-only.
const mongoose = require("mongoose");
const SupportCase = require("../models/SupportCase");
const User = require("../models/User");
const notificationService = require("./notificationService");
const auditService = require("./auditService");

const CATEGORIES = SupportCase.schema.path("category").enumValues;
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const OVERDUE_HOURS = 24;

const forCustomer = (c) => {
    const o = c.toObject ? c.toObject() : c;
    return { ...o, messages: (o.messages || []).filter((m) => !m.internal), contactHistory: undefined, assignedTo: undefined };
};

async function notifyStaff(title, message, metadata) {
    const staff = await User.find({ role: { $in: ["superadmin", "admin", "caller_support"] }, isActive: true }).select("_id").limit(50);
    await Promise.allSettled(staff.map((s) => notificationService.createNotification(s._id, title, message, "in_app", metadata)));
}

async function notifyCustomer(c, text) {
    if (!c.customerId) return;
    const meta = { supportCaseId: String(c._id), event: "supportReply" };
    await Promise.allSettled([
        notificationService.createNotification(c.customerId, "MOTA support replied", text.slice(0, 140), "in_app", meta),
        notificationService.sendPushNotification(c.customerId, "MOTA support replied", text.slice(0, 140), meta),
    ]);
}

// ─── Customer (mobile app) ───────────────────────────────────────────────────
async function listMine(userId, page = 1, limit = 20) {
    const filter = { $or: [{ customerId: userId }, { createdBy: userId }] };
    const [items, total] = await Promise.all([
        SupportCase.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit),
        SupportCase.countDocuments(filter),
    ]);
    return { data: items.map(forCustomer), totalItems: total, totalPages: Math.max(1, Math.ceil(total / limit)), page };
}

async function getMine(userId, id) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, "Support request not found.");
    const c = await SupportCase.findOne({ _id: id, $or: [{ customerId: userId }, { createdBy: userId }] });
    if (!c) throw httpError(404, "Support request not found.");
    return forCustomer(c);
}

async function create(user, body) {
    const subject = String(body.subject || "").trim();
    const description = String(body.description || "").trim();
    if (subject.length < 3 || description.length < 5) throw httpError(400, "Add a short subject and describe the problem.");
    const category = CATEGORIES.includes(body.category) ? body.category : "other";
    const attachments = Array.isArray(body.attachments)
        ? body.attachments.filter((a) => a && /^https:\/\//.test(a.url || "")).slice(0, 5).map((a) => ({ url: a.url, name: String(a.name || "file").slice(0, 200) }))
        : [];
    const c = await SupportCase.create({
        customerId: user._id,
        rideId: mongoose.isValidObjectId(body.rideId) ? body.rideId : undefined,
        category,
        subject: subject.slice(0, 160),
        description: description.slice(0, 4000),
        priority: category === "safety" ? "urgent" : ["payment", "withdrawal"].includes(category) ? "high" : "normal",
        status: "open",
        createdBy: user._id,
        attachments,
        messages: [{ authorId: user._id, authorType: "customer", text: description.slice(0, 4000) }],
        lastCustomerMessageAt: new Date(),
    });
    await notifyStaff(`New support request: ${c.subject}`, `${user.firstName} ${user.lastName} · ${category}`, { supportCaseId: String(c._id) });
    return forCustomer(c);
}

async function customerReply(user, id, text, { reopen = false } = {}) {
    const body = String(text || "").trim();
    if (!body) throw httpError(400, "Write a message first.");
    const c = await SupportCase.findOne({ _id: id, $or: [{ customerId: user._id }, { createdBy: user._id }] });
    if (!c) throw httpError(404, "Support request not found.");
    if (["resolved", "closed"].includes(c.status) && !reopen) throw httpError(409, "This request is closed. Reopen it to continue.");
    c.messages.push({ authorId: user._id, authorType: "customer", text: body.slice(0, 4000) });
    c.lastCustomerMessageAt = new Date();
    if (reopen) c.status = "open";
    await c.save();
    await notifyStaff(`${reopen ? "Reopened" : "Reply"}: ${c.subject}`, body.slice(0, 140), { supportCaseId: String(c._id) });
    return forCustomer(c);
}

// ─── Staff (admin panel) ─────────────────────────────────────────────────────
async function staffReply(staff, id, { text, internal = false, status }) {
    const body = String(text || "").trim();
    if (!body) throw httpError(400, "Write a message first.");
    if (!mongoose.isValidObjectId(id)) throw httpError(404, "Support case not found.");
    const c = await SupportCase.findById(id);
    if (!c) throw httpError(404, "Support case not found.");
    c.messages.push({ authorId: staff._id, authorType: "staff", text: body.slice(0, 4000), internal: Boolean(internal) });
    if (!internal) c.lastStaffReplyAt = new Date();
    if (status) {
        if (!SupportCase.schema.path("status").enumValues.includes(status)) throw httpError(400, "Invalid status.");
        c.status = status;
    } else if (!internal && c.status === "open") {
        c.status = "in_progress";
    }
    await c.save();
    if (!internal) await notifyCustomer(c, body);
    await auditService.log({ actorId: staff._id, actorRole: staff.role, action: "support_message_added", targetType: "SupportCase", targetId: c._id, metadata: { internal: Boolean(internal), status: c.status } });
    return c;
}

async function summary() {
    const active = { status: { $in: ["open", "in_progress"] } };
    const overdueBefore = new Date(Date.now() - OVERDUE_HOURS * 3600000);
    const [activeCount, overdue, urgent, waitingAgg] = await Promise.all([
        SupportCase.countDocuments(active),
        SupportCase.countDocuments({ ...active, createdAt: { $lt: overdueBefore } }),
        SupportCase.countDocuments({ ...active, priority: { $in: ["urgent", "high"] } }),
        // Waiting = the customer spoke last.
        SupportCase.countDocuments({ ...active, lastCustomerMessageAt: { $ne: null }, $expr: { $or: [{ $eq: [{ $ifNull: ["$lastStaffReplyAt", null] }, null] }, { $gt: ["$lastCustomerMessageAt", "$lastStaffReplyAt"] }] } }),
    ]);
    return { active: activeCount, overdue, urgent, waiting: waitingAgg, overdueHours: OVERDUE_HOURS };
}

module.exports = { CATEGORIES, listMine, getMine, create, customerReply, staffReply, summary };
