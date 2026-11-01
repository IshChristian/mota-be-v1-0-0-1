// Signed direct uploads to Cloudinary. The phone/browser sends the file straight
// to Cloudinary; the server only signs the exact parameters (folder, random
// public_id, no overwrite, timestamp), so the API secret never leaves the server
// and a signature can't be reused to overwrite someone else's file.
const crypto = require("crypto");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 60;
const usage = new Map(); // userId -> [timestamps]

/** Cloudinary signature: SHA-1 of the sorted "k=v&k=v" params followed by the API secret. */
function sign(params, secret) {
    const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    return crypto.createHash("sha1").update(toSign + secret).digest("hex");
}

function createSignature(user) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME, apiKey = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !secret) throw httpError(503, "File uploads are not configured on the server (Cloudinary credentials missing).");
    const key = String(user._id), now = Date.now();
    const recent = (usage.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_PER_WINDOW) throw httpError(429, "Too many uploads in the last hour. Try again later.");
    recent.push(now); usage.set(key, recent);
    const staff = !["client", "driver"].includes(user.role);
    const params = {
        folder: `mota/${staff ? "staff" : user.role}/${key}`,
        overwrite: false,
        public_id: `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`,
        timestamp: Math.floor(now / 1000),
    };
    return { cloudName, apiKey, signature: sign(params, secret), params };
}

module.exports = { createSignature, sign };
