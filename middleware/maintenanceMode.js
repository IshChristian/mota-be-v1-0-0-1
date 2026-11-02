// Maintenance mode (admin panel → Settings → Platform). While on, the driver and
// passenger apps get 503 with the configured message; staff keep full access so
// they can work on the platform. Sign-in, platform info, shared trip links and
// payment webhooks keep working so money in flight still settles.
const jwt = require("jsonwebtoken");
const { getSetting } = require("../services/systemSettingService");

const STAFF = new Set(["superadmin", "admin", "manager", "moderator", "financial", "caller_support"]);
const OPEN_PATHS = [/^\/api\/auth\//, /^\/api\/platform\//, /^\/api\/share\//, /webhook/, /callback/, /^\/api\/production\/status/];

module.exports = async function maintenanceMode(req, res, next) {
    try {
        const on = await getSetting("maintenance_mode", false);
        if (on !== true && on !== "true") return next();
        const path = req.originalUrl.split("?")[0];
        if (OPEN_PATHS.some((re) => re.test(path))) return next();
        const header = String(req.headers.authorization || "");
        if (header.startsWith("Bearer ")) {
            try {
                if (STAFF.has(jwt.verify(header.slice(7), process.env.JWT_SECRET).role)) return next();
            } catch { /* invalid token: treat as a normal user */ }
        }
        const message = await getSetting("maintenance_message", "MOTA is being updated. Please try again shortly.");
        res.set("Retry-After", "300");
        return res.status(503).json({ code: "MAINTENANCE", message });
    } catch {
        return next(); // never lock everyone out because the setting couldn't be read
    }
};
