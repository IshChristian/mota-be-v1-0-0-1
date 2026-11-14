// Phone verification over WhatsApp: the user sends "MOTA verify <code>" to MOTA's number
// and the sender's number proves they own the phone. Only free replies are ever sent.
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { startStack, stopStack, ROOT } = require("./harness");
const path = require("path");
const load = (p) => require(path.join(ROOT, p));

const WA_ENV = {
    WHATSAPP_TOKEN: "wa-token",
    WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    WHATSAPP_APP_SECRET: "wa-secret",
    WHATSAPP_VERIFY_TOKEN: "wa-verify",
    WHATSAPP_BUSINESS_NUMBER: "250788000000",
};

let app, User;
const realFetch = global.fetch;
let sent;
let seq = 0;

before(async () => {
    app = await startStack();
    Object.assign(process.env, WA_ENV);
    User = load("models/User.js");
});
after(async () => { global.fetch = realFetch; await stopStack(); });
afterEach(async () => { global.fetch = realFetch; Object.assign(process.env, WA_ENV); await User.deleteMany({}); });

const mockGraph = () => {
    sent = [];
    global.fetch = async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
};

const newUser = (extra = {}) => User.create({
    firstName: "Aline", lastName: "Uwase", phone: `078${String(8100000 + ++seq).slice(-7)}`,
    role: "client", isVerified: false, isActive: false, ...extra,
});

const start = (userId) => request(app).post("/api/auth/whatsapp/start").send({ userId: String(userId) });
const codeFrom = (link) => decodeURIComponent(link).match(/(\d{6})$/)[1];

// ─── Task 1: start + status ─────────────────────────────────────────────────

test("start returns a wa.me link with a 6-digit code", async () => {
    const user = await newUser();
    const res = await start(user._id);
    assert.equal(res.status, 200);
    assert.match(res.body.link, /^https:\/\/wa\.me\/250788000000\?text=MOTA%20verify%20\d{6}$/);
    const ahead = new Date(res.body.expiresAt).getTime() - Date.now();
    assert.ok(Math.abs(ahead - 15 * 60 * 1000) < 5000, `expiresAt ${ahead} ms ahead`);
    const stored = await User.findById(user._id).lean();
    assert.ok(stored.waVerifyCodeHash && !stored.waVerifyCodeHash.includes(codeFrom(res.body.link)));
});

test("start for a verified user is 400", async () => {
    const user = await newUser({ isVerified: true });
    assert.equal((await start(user._id)).status, 400);
});

test("start for unknown id is 404", async () => {
    assert.equal((await start("64b000000000000000000000")).status, 404);
});

test("start is 503 when WhatsApp is not configured", async () => {
    const user = await newUser();
    delete process.env.WHATSAPP_TOKEN;
    assert.equal((await start(user._id)).status, 503);
});

test("status reports verified false then true", async () => {
    const user = await newUser();
    const check = () => request(app).get("/api/auth/whatsapp/status").query({ userId: String(user._id) });
    assert.deepEqual((await check()).body, { verified: false });
    await User.updateOne({ _id: user._id }, { isVerified: true });
    assert.deepEqual((await check()).body, { verified: true });
});

test("verifyOTP still verifies via the shared helper", async () => {
    const { generateOTPToken } = load("utils/jwt.js");
    const user = await newUser();
    user.otpToken = generateOTPToken(user._id, "123456");
    await user.save();
    const res = await request(app).post("/api/auth/verify-otp").send({ userId: String(user._id), otp: "123456" });
    assert.equal(res.status, 200);
    const stored = await User.findById(user._id).lean();
    assert.equal(stored.isVerified, true);
    assert.equal(stored.isActive, true);
    assert.equal(stored.otpToken, null);
});

