const SupportCase = require("../models/SupportCase");
const Ride = require("../models/Ride");
const { CATEGORIES, STATUSES } = require("../constants/support");
const { cloudinary } = require("../services/uploadService");
const notifications = require("../services/notificationService");
const audit = require("../services/auditService");
const id = (value) => /^[a-f0-9]{24}$/i.test(String(value || ""));
const userId = (req) => String(req.user.id || req.user._id);
function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function text(value, name, limit) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit)
    fail(400, `${name} must contain 1–${limit} characters.`);
  return value.trim();
}
function attachments(value, owner) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5)
    fail(400, "Attach up to five files.");
  const cloud = cloudinary.config().cloud_name;
  return value.map((file) => {
    let url;
    try {
      url = new URL(file.url);
    } catch {
      fail(400, "Invalid attachment link.");
    }
    if (
      !cloud ||
      url.protocol !== "https:" ||
      url.hostname !== "res.cloudinary.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(`/${cloud}/`) ||
      !url.pathname.includes(`/mota_uploads/${owner}/`)
    )
      fail(400, "Upload attachments from your own account before adding them.");
    return { url: url.toString(), name: text(file.name, "Filename", 160) };
  });
}
function publicCase(item) {
  const c = item.toObject ? item.toObject() : item;
  return {
    _id: c._id,
    reference: `MOTA-${c._id}`,
    subject: c.subject,
    description: c.description,
    category: c.category,
    status: c.status,
    priority: c.priority,
    rideId: c.rideId,
    attachments: c.attachments || [],
    resolution: c.resolution || "",
    responseDueAt: c.responseDueAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messages: (c.messages || [])
      .filter((m) => !m.internal)
      .map((m) => ({
        text: m.text,
        authorType: m.authorType,
        attachments: m.attachments || [],
        createdAt: m.createdAt,
      })),
  };
}
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    res.status(error.status || 500).json({
      message: error.status
        ? error.message
        : "Could not complete the support request. Please retry.",
    });
  }
};
const list = wrap(async (req, res) => {
  const page = Math.max(1, Math.min(1000, parseInt(req.query.page) || 1)),
    limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 20)),
    filter = { customerId: userId(req) };
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status))
      fail(400, "Invalid support status.");
    filter.status = req.query.status;
  }
  const [data, total] = await Promise.all([
    SupportCase.find(filter)
      .select("-messages -contactHistory")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    SupportCase.countDocuments(filter),
  ]);
  res.json({ data: data.map(publicCase), page, limit, total });
});
const details = wrap(async (req, res) => {
  if (!id(req.params.id)) fail(400, "Invalid case reference.");
  const c = await SupportCase.findOne({
    _id: req.params.id,
    customerId: userId(req),
  });
  if (!c) fail(404, "Support case not found.");
  res.json({ data: publicCase(c) });
});
const create = wrap(async (req, res) => {
  const body = req.body || {},
    category = body.category || "other";
  if (!CATEGORIES.includes(category))
    fail(400, "Choose a valid support category.");
  if (body.rideId) {
    if (!id(body.rideId)) fail(400, "Invalid ride reference.");
    const ride = await Ride.findOne({
      _id: body.rideId,
      $or: [{ passengerId: userId(req) }, { driverId: userId(req) }],
    });
    if (!ride) fail(404, "Ride not found for your account.");
  }
  const item = await SupportCase.create({
    customerId: userId(req),
    createdBy: userId(req),
    rideId: body.rideId || undefined,
    category,
    subject: text(body.subject, "Subject", 160),
    description: text(body.description, "Description", 4000),
    attachments: attachments(body.attachments, userId(req)),
    priority: category === "safety" ? "urgent" : "normal",
    responseDueAt: new Date(
      Date.now() +
        Math.max(
          15,
          Math.min(
            10080,
            Number(process.env.SUPPORT_RESPONSE_TARGET_MINUTES) || 1440,
          ),
        ) *
          60000,
    ),
  });
  res.status(201).json({
    message: "Support request received. Follow replies here.",
    data: publicCase(item),
  });
});
const reply = wrap(async (req, res) => {
  if (!id(req.params.id)) fail(400, "Invalid case reference.");
  const message = {
    text: text((req.body || {}).text, "Message", 4000),
    attachments: attachments((req.body || {}).attachments, userId(req)),
    authorId: userId(req),
    authorType: "user",
    internal: false,
    createdAt: new Date(),
  };
  const c = await SupportCase.findOneAndUpdate(
    {
      _id: req.params.id,
      customerId: userId(req),
      status: { $nin: ["closed", "resolved"] },
    },
    { $push: { messages: message }, $set: { status: "open" } },
    { new: true, runValidators: true },
  );
  if (!c)
    fail(
      409,
      "Case unavailable or resolved. Reopen your case before replying.",
    );
  res.json({ data: publicCase(c) });
});
const reopen = wrap(async (req, res) => {
  if (!id(req.params.id)) fail(400, "Invalid case reference.");
  const message = text((req.body || {}).text, "Reason", 4000);
  const c = await SupportCase.findOneAndUpdate(
    {
      _id: req.params.id,
      customerId: userId(req),
      status: { $in: ["resolved", "closed"] },
    },
    {
      $set: { status: "reopened", resolution: "" },
      $push: {
        messages: {
          text: message,
          authorId: userId(req),
          authorType: "user",
          internal: false,
          createdAt: new Date(),
        },
      },
    },
    { new: true, runValidators: true },
  );
  if (!c) fail(409, "Only your resolved or closed case can be reopened.");
  res.json({ data: publicCase(c) });
});
const staffReply = wrap(async (req, res) => {
  if (!id(req.params.id)) fail(400, "Invalid case reference.");
  const body = req.body || {},
    message = text(body.text, "Message", 4000);
  if (body.internal !== undefined && typeof body.internal !== "boolean")
    fail(400, "internal must be a boolean.");
  if (body.status && !STATUSES.includes(body.status))
    fail(400, "Invalid support status.");
  if (body.internal === true && body.status)
    fail(400, "Private notes cannot change public case status.");
  const update = {
    $push: {
      messages: {
        text: message,
        authorId: userId(req),
        authorType: "staff",
        internal: body.internal === true,
        createdAt: new Date(),
      },
    },
  };
  if (body.status) {
    update.$set = { status: body.status };
    if (["resolved", "closed"].includes(body.status))
      update.$set.resolution = message;
  }
  const c = await SupportCase.findByIdAndUpdate(req.params.id, update, {
    new: true,
    runValidators: true,
  });
  if (!c) fail(404, "Support case not found.");
  await audit
    .log({
      actorId: userId(req),
      actorRole: req.user.role,
      action: "support_case_updated",
      targetType: "SupportCase",
      targetId: c._id,
      metadata: { internal: body.internal === true, status: c.status },
    })
    .catch(() => {});
  if (!body.internal && c.customerId)
    await notifications
      .createNotification(
        c.customerId,
        "MOTA support replied",
        `Your support case ${c.subject} has an update.`,
        "in_app",
        { category: "support", supportCaseId: String(c._id) },
      )
      .catch(() => {});
  res.json({ data: c });
});
module.exports = {
  list,
  details,
  create,
  reply,
  reopen,
  staffReply,
  publicCase,
};
