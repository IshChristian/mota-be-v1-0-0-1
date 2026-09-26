const User = require("../models/User");
const notifications = require("./notificationService");
const { STAFF_ROLE_TEMPLATES } = require("../constants/staffRoles");

async function notifyNewSupportCase(item) {
    const creator = await User.findById(item.createdBy).select("firstName lastName role").lean();
    const staff = await User.find({ role: { $in: ["admin", "superadmin", "caller_support"] }, isActive: true })
        .select("firstName email role roleId").populate("roleId", "permissions").lean();
    const recipients = staff.filter(user => (user.roleId?.permissions || STAFF_ROLE_TEMPLATES[user.role] || []).includes("support:view"));
    const source = creator?.role === "agent" ? "agent" : creator?.role === "driver" ? "driver" : creator?.role === "client" ? "passenger" : "staff";
    const title = "New MOTA support request";
    const message = `A new ${source} request is awaiting review in the support queue.`;
    const metadata = { supportCaseId: String(item._id), event: "support_case_created" };
    await Promise.allSettled(recipients.map(async user => {
        await notifications.createNotification(user._id, title, message, "in_app", metadata);
        await Promise.allSettled([
            notifications.sendPushNotification(user._id, title, message, metadata),
            user.email ? notifications.sendEmail(user.email, title, message) : Promise.resolve(),
        ]);
    }));
}

module.exports = { notifyNewSupportCase };
