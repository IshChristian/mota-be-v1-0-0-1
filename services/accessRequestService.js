const AccessRequest = require("../models/AccessRequest");
const User = require("../models/User");
const { PERMISSIONS } = require("../constants/staffRoles");

const APPROVAL_HOURS = 24;
// Only the superadmin holds these; they can't be borrowed through a request.
const NOT_REQUESTABLE = ["access_request:approve", "data:access_manage"];
const httpError = (status, message) => Object.assign(new Error(message), { status });
const notifications = () => require("./notificationService");
const audit = (entry) => require("./auditService").log(entry);
const { effectivePermissions } = require("./reportAccess");

/** "expired" is shown, not stored: an approval past its time is simply unusable. */
const view = (row) => {
    const plain = row.toObject ? row.toObject() : row;
    const expired = plain.status === "approved" && plain.expiresAt && plain.expiresAt < new Date();
    return { ...plain, status: expired ? "expired" : plain.status };
};

const createRequest = async (requester, { permission, targetType, targetId, reason }, ip) => {
    permission = String(permission || "").trim();
    reason = String(reason || "").trim();
    if (!PERMISSIONS.includes(permission) || NOT_REQUESTABLE.includes(permission)) throw httpError(400, "This permission can't be requested.");
    if (effectivePermissions(requester).includes(permission)) throw httpError(400, "You already have this permission.");
    if (reason.length < 5) throw httpError(400, "Add a reason of at least 5 characters.");
    const target = targetId ? String(targetId) : null;
    const open = await AccessRequest.findOne({ requesterId: requester._id, permission, targetId: target, status: "pending" });
    if (open) return { request: view(open), created: false };
    const request = await AccessRequest.create({ requesterId: requester._id, permission, targetType: targetType ? String(targetType) : undefined, targetId: target, reason });
    const owners = await User.find({ role: "superadmin", isActive: true }).select("_id").lean();
    const name = `${requester.firstName || ""} ${requester.lastName || ""}`.trim() || "A staff member";
    const what = target ? `${permission} on ${targetType || "record"} ${target}` : permission;
    await Promise.allSettled(owners.map((owner) => notifications().createNotification(owner._id, "Access request", `${name} (${requester.role}) asks for ${what}: ${reason}`, "in_app", { accessRequestId: String(request._id) })));
    await audit({ actorId: requester._id, actorRole: requester.role, action: "access_requested", targetType: "AccessRequest", targetId: request._id, ipAddress: ip, metadata: { permission, targetType, targetId: target, reason } });
    return { request: view(request), created: true };
};

const listRequests = async ({ requesterId, status } = {}) => {
    const filter = {};
    if (requesterId) filter.requesterId = requesterId;
    if (status === "pending") filter.status = "pending";
    const rows = await AccessRequest.find(filter).populate("requesterId", "firstName lastName role").populate("decidedBy", "firstName lastName").sort({ createdAt: -1 }).limit(200);
    return rows.map(view);
};

const decideRequest = async (decider, id, decision, note, ip) => {
    const approve = decision === "approve";
    const request = await AccessRequest.findOneAndUpdate(
        { _id: id, status: "pending" },
        { $set: {
            status: approve ? "approved" : "declined", decidedBy: decider._id, decidedAt: new Date(),
            decisionNote: String(note || "").trim() || undefined,
            ...(approve ? { expiresAt: new Date(Date.now() + APPROVAL_HOURS * 3600 * 1000) } : {}),
        } },
        { returnDocument: "after" },
    );
    if (!request) throw httpError(409, "This request has already been decided.");
    const what = request.targetId ? `${request.permission} on ${request.targetType || "record"} ${request.targetId}` : request.permission;
    await notifications().createNotification(request.requesterId, approve ? "Access request approved" : "Access request declined",
        approve ? `You can now do ${what} once, within ${APPROVAL_HOURS} hours.` : `Your request for ${what} was declined.${request.decisionNote ? ` ${request.decisionNote}` : ""}`,
        "in_app", { accessRequestId: String(request._id) }).catch(() => {});
    await audit({ actorId: decider._id, actorRole: decider.role, action: approve ? "access_request_approved" : "access_request_declined", targetType: "AccessRequest", targetId: request._id, ipAddress: ip, metadata: { permission: request.permission, targetId: request.targetId, requesterId: String(request.requesterId), note: request.decisionNote } });
    return view(request);
};

/**
 * Use an approval: true only for a live approval of exactly this permission on
 * exactly this target. The status change is atomic, so it works once.
 */
const consumeApproval = async (user, permission, targetId, ip) => {
    const used = await AccessRequest.findOneAndUpdate(
        { requesterId: user._id, permission, targetId: targetId ? String(targetId) : null, status: "approved", expiresAt: { $gt: new Date() } },
        { $set: { status: "used", usedAt: new Date() } },
        { returnDocument: "after" },
    );
    if (!used) return false;
    await audit({ actorId: user._id, actorRole: user.role, action: "access_request_used", targetType: "AccessRequest", targetId: used._id, ipAddress: ip, metadata: { permission, targetId: used.targetId } });
    return true;
};

module.exports = { createRequest, listRequests, decideRequest, consumeApproval, APPROVAL_HOURS, NOT_REQUESTABLE };
