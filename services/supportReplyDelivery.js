const SupportCase = require("../models/SupportCase");
const Notification = require("../models/Notification");
const { ensureDedupeIndex } = require("./supportAlerts");
let running = false;

async function deliverCase(item) {
  if (!item.customerId) return { sent: 0, failed: 0 };
  await ensureDedupeIndex();
  let sent = 0,
    failed = 0;
  for (const message of item.messages || []) {
    if (
      message.authorType !== "staff" ||
      message.internal ||
      message.notificationPending !== true ||
      !message._id
    )
      continue;
    const dedupeKey = `support-reply:${item._id}:${message._id}:${item.customerId}`;
    try {
      try {
        await Notification.updateOne(
          { dedupeKey },
          {
            $setOnInsert: {
              dedupeKey,
              userId: item.customerId,
              type: "in_app",
              read: false,
              title: "MOTA support replied",
              message: "Your support conversation has a new reply.",
              metadata: {
                category: "support",
                supportCaseId: String(item._id),
                supportMessageId: String(message._id),
              },
            },
          },
          { upsert: true, runValidators: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
      await SupportCase.updateOne(
        {
          _id: item._id,
          customerId: item.customerId,
          messages: {
            $elemMatch: {
              _id: message._id,
              authorType: "staff",
              internal: false,
              notificationPending: true,
            },
          },
        },
        {
          $set: {
            "messages.$.notificationPending": false,
            "messages.$.notificationRecordedAt": new Date(),
          },
        },
      );
      sent++;
    } catch {
      failed++;
    }
  }
  return { sent, failed };
}

async function runSupportReplyDelivery() {
  if (running) return { skipped: true, sent: 0, failed: 0 };
  running = true;
  try {
    // Closed cases still need notification delivery; status must not filter this queue.
    const cases = await SupportCase.find({
      customerId: { $ne: null },
      messages: {
        $elemMatch: {
          authorType: "staff",
          internal: false,
          notificationPending: true,
        },
      },
    })
      .select("_id customerId messages")
      .sort({ updatedAt: 1, _id: 1 })
      .limit(100)
      .lean();
    let sent = 0,
      failed = 0;
    for (const item of cases) {
      try {
        const result = await deliverCase(item);
        sent += result.sent;
        failed += result.failed;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  } finally {
    running = false;
  }
}
module.exports = { deliverCase, runSupportReplyDelivery };
