// The app polls /api/auth/whatsapp/status while the user is in WhatsApp. With production
// auth limits (30 per 15 min per IP) that polling must neither be refused nor use up the
// budget that registration, verify-otp and login share.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const request = require("supertest");
const { startStack, stopStack, ROOT } = require("./harness");

let app, User;

before(async () => {
    process.env.AUTH_RATE_LIMIT_PER_15_MIN = "30"; // the production default
    app = await startStack();
    User = require(path.join(ROOT, "models/User.js"));
});
after(stopStack);

test("status polling is not limited by, and does not consume, the auth limit", async () => {
    const user = await User.create({ firstName: "Aline", lastName: "Uwase", phone: "0788123456", role: "client" });
    for (let i = 0; i < 60; i++) { // 3 minutes of polling every 3 s
        const res = await request(app).get("/api/auth/whatsapp/status").query({ userId: String(user._id) });
        assert.equal(res.status, 200, `poll ${i + 1} was refused`);
    }
    const otp = await request(app).post("/api/auth/verify-otp").send({ userId: String(user._id), otp: "000000" });
    assert.notEqual(otp.status, 429, "polling used up the auth limit");
});
