// Which browser origins may call the API (the MOTA web app, admin panel, local dev).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startStack, stopStack } = require("./harness");
const request = require("supertest");

process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com,\nhttps://web.example.com/";
const { isAllowedOrigin } = require("../config/corsOrigins");

let app;
before(async () => { app = await startStack(); });
after(stopStack);

test("native apps (no Origin), the admin panel, configured and local dev origins are allowed", () => {
    for (const origin of [undefined, "", "https://mota-admin-web-app.vercel.app", "https://app.example.com", "https://web.example.com",
        "http://localhost:8081", "http://localhost", "http://127.0.0.1:5173", "http://[::1]:8081"]) {
        assert.equal(isAllowedOrigin(origin), true, String(origin));
    }
});

test("unknown sites and look-alike origins are rejected", () => {
    for (const origin of ["https://evil.example", "https://localhost:8081", "http://localhost.evil.com", "http://localhost:8081.evil.com",
        "https://app.example.com.evil.com", "http://app.example.com", "null", "not a url"]) {
        assert.equal(isAllowedOrigin(origin), false, origin);
    }
});

test("browser preflight from the Expo web app gets CORS headers", async () => {
    const res = await request(app).options("/api/platform/mobile-release")
        .set("Origin", "http://localhost:8081")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "authorization,content-type");
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8081");
    assert.match(res.headers["access-control-allow-headers"], /Authorization/);
});

test("a request from an unknown site gets no CORS headers", async () => {
    const res = await request(app).get("/api/platform/mobile-release").set("Origin", "https://evil.example");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
});
