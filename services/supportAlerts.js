const SupportCase = require("../models/SupportCase");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { effectivePermissions } = require("./reportAccess");
const { STAFF_ROLES } = require("../constants/staffRoles");

const activeStatuses = ["open", "in_progress", "waiting", "reopened"];
const responseDeadline = () =>
  new Date(
    Date.now() +
      Math.max(
        15,
        Math.min(
          10080,
          Number(process.env.SUPPORT_RESPONSE_TARGET_MINUTES) || 1440,
        ),
      ) *
        60000,
  );
let running = false;
let timer;
let indexPromise;
function ensureDedupeIndex() {
  if (!indexPromise)
    indexPromise = Notification.collection
      .createIndex({ dedupeKey: 1 }, { unique: true, sparse: true })
      .catch((error) => {
        indexPromise = undefined;
        throw error;
      });
  return indexPromise;
}

function canReceive(user) {
  const permissions = effectivePermissions(user);
  return (
    permissions.includes("admin:access") && permissions.includes("support:view")
  );
}

async function writeNotice(userId, item, event, revision) {
  const dedupeKey = `support:${item._id}:${event}:${revision}:${userId}`;
  try {
    await Notification.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          dedupeKey,
          userId,
          type: "in_app",
          read: false,
          title:
            event === "overdue"
              ? "Support response target passed"
              : "Support request needs attention",
          message:
            event === "overdue"
              ? "Review this support case and update its response status."
              : "A support request or user reply is waiting in the support workspace.",
          metadata: {
            category: "support",
            event,
            supportCaseId: String(item._id),
            audience: "staff",
          },
        },
      },
      { upsert: true, runValidators: true },
    );
  } catch (error) {
    // A concurrent worker may have completed the same unique upsert.
    if (error.code !== 11000) throw error;
  }
}

async function notifyAll(recipients, item, event, revision) {
  for (let start = 0; start < recipients.length; start += 25) {
    const results = await Promise.allSettled(
      recipients
        .slice(start, start + 25)
        .map((user) => writeNotice(user._id, item, event, revision)),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Support notification delivery will be retried.");
  }
}

async function runSupportAlerts(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  try {
    await ensureDedupeIndex();
    const candidates = await User.find({
      isActive: true,
      deletedAt: null,
      role: { $in: [...STAFF_ROLES, "manager", "moderator"] },
    })
      .select("_id role roleId reportPermissions")
      .populate("roleId", "permissions")
      .lean();
    const recipients = candidates.filter(canReceive);
    if (!recipients.length) return { cases: 0, recipients: 0 };
    const cases = await SupportCase.find({
      status: { $in: activeStatuses },
      $or: [
        {
          staffAlertRevision: { $exists: true },
          staffAlertCancelled: { $ne: true },
          $expr: {
            $gt: [
              { $ifNull: ["$staffAlertRevision", 0] },
              { $ifNull: ["$staffAlertedRevision", -1] },
            ],
          },
        },
        {
          responseDueAt: { $lte: now, $ne: null },
          $expr: {
            $ne: [
              "$responseDueAt",
              { $ifNull: ["$staffOverdueAlertedFor", null] },
            ],
          },
        },
      ],
    })
      .select(
        "_id status staffAlertCancelled staffAlertRevision staffAlertedRevision responseDueAt staffOverdueAlertedFor",
      )
      .sort({ responseDueAt: 1, createdAt: 1 })
      .limit(200)
      .lean();
    let completed = 0,
      failed = 0;
    for (const item of cases) {
      try {
        const revision = item.staffAlertRevision;
        if (
          !item.staffAlertCancelled &&
          Number.isFinite(revision) &&
          revision > (item.staffAlertedRevision ?? -1)
        ) {
          await notifyAll(recipients, item, "update", revision);
          await SupportCase.updateOne(
            {
              _id: item._id,
              status: { $in: activeStatuses },
              $expr: {
                $eq: [{ $ifNull: ["$staffAlertRevision", 0] }, revision],
              },
            },
            { $set: { staffAlertedRevision: revision } },
          );
        }
        if (
          item.responseDueAt &&
          new Date(item.responseDueAt) <= now &&
          new Date(item.staffOverdueAlertedFor || 0).getTime() !==
            new Date(item.responseDueAt).getTime()
        ) {
          await notifyAll(
            recipients,
            item,
            "overdue",
            new Date(item.responseDueAt).getTime(),
          );
          await SupportCase.updateOne(
            {
              _id: item._id,
              status: { $in: activeStatuses },
              responseDueAt: item.responseDueAt,
            },
            {
              $set: {
                staffOverdueAlertedFor: item.responseDueAt,
                escalated: true,
              },
            },
          );
        }
        completed++;
      } catch {
        failed++;
      }
    }
    return { cases: completed, failed, recipients: recipients.length };
  } finally {
    running = false;
  }
}

function startSupportAlerts() {
  if (timer) return;
  const tick = () =>
    Promise.all([
      runSupportAlerts(),
      require("./supportReplyDelivery").runSupportReplyDelivery(),
    ])
      .then((results) => {
        if (results.some((result) => result.failed))
          console.warn(
            "Support alert delivery incomplete; retrying next minute.",
          );
      })
      .catch(() =>
        console.warn("Support alert scan unavailable; retrying next minute."),
      );
  void tick();
  timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
}
module.exports = {
  ensureDedupeIndex,
  runSupportAlerts,
  startSupportAlerts,
  canReceive,
  activeStatuses,
  responseDeadline,
};
