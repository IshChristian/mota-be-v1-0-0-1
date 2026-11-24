// Who a rate limit counts. Render puts Cloudflare and its own proxy in front of the API, so
// req.ip is a proxy shared by every user. Cloudflare sets CF-Connecting-IP itself and refuses
// requests that try to supply it.
const jwt = require("jsonwebtoken");
const { ipKeyGenerator } = require("express-rate-limit");

const ipKey = (req) => `ip:${ipKeyGenerator(String(req.headers["cf-connecting-ip"] || req.ip || "unknown"))}`;

/** The signed-in person when the token is genuine, otherwise null. */
const userKey = (req) => {
    const [scheme, token] = String(req.headers.authorization || "").split(" ");
    if (scheme !== "Bearer" || !token) return null;
    try { return `user:${jwt.verify(token, process.env.JWT_SECRET).id}`; } catch { return null; }
};

/** Sign-in and code requests: one account from one address (mobile carriers share addresses). */
const accountKey = (req) => {
    const body = req.body || {};
    const account = body.email || body.phone || body.identifier || body.userId || "";
    return `${ipKey(req)}:${String(account).trim().toLowerCase().slice(0, 120)}`;
};

module.exports = { ipKey, userKey, accountKey };
