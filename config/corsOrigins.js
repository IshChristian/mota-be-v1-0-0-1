// Browser origins allowed to call the API and open the Socket.IO connection.
// Native apps send no Origin header and are always allowed.
//
// Auth is a bearer token in the Authorization header (no cookies), so allowing an
// origin only lets a page that already holds a token use it — it never exposes
// another user's session. That is why local development origins are safe to allow.
//
// Production web domains are added with CORS_ALLOWED_ORIGINS (comma or newline
// separated), e.g. "https://app.mota.africa,https://mota-web.vercel.app".

const DEFAULT_ORIGINS = ["https://mota-admin-web-app.vercel.app", "https://mota.tiangroupinv.rw", "http://localhost:8081"];

// Expo web (8081), Vite (5173) and any other local dev server.
const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

const normalizeOrigin = (value) => {
    try { return new URL(String(value).trim()).origin; } catch { return ""; }
};

function configuredOrigins() {
    return new Set([
        ...DEFAULT_ORIGINS,
        ...(process.env.CORS_ALLOWED_ORIGINS || "").split(/[\n,]/),
    ].map(normalizeOrigin).filter(Boolean));
}

function isAllowedOrigin(origin) {
    if (!origin) return true;
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    return LOCAL_DEV_ORIGIN.test(normalized) || configuredOrigins().has(normalized);
}

module.exports = { isAllowedOrigin, normalizeOrigin };
