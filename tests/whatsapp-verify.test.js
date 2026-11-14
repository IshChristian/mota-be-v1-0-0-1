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


// ─── Task 2: webhook ────────────────────────────────────────────────────────

const SUCCESS = "✅ Your MOTA number is verified. Go back to the app.";
const MISMATCH = "This WhatsApp number isn't the phone you signed up with.";
const EXPIRED = "That code has expired. Tap Verify with WhatsApp in the app again.";

const sign = (raw, secret = WA_ENV.WHATSAPP_APP_SECRET) => `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
const hook = (payload, signature) => {
    const raw = JSON.stringify(payload);
    return request(app).post("/api/webhooks/whatsapp")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", signature === undefined ? sign(raw) : signature)
        .send(raw);
};
const messageFrom = (from, body) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ from, id: "wamid.x", type: "text", text: { body } }] } }] }],
});
const startCode = async (user) => codeFrom((await start(user._id)).body.link);

test("handshake echoes challenge with the right token", async () => {
    const res = await request(app).get("/api/webhooks/whatsapp")
        .query({ "hub.mode": "subscribe", "hub.verify_token": "wa-verify", "hub.challenge": "42xyz" });
    assert.equal(res.status, 200);
    assert.equal(res.text, "42xyz");
});

test("handshake 403 with wrong token", async () => {
    const res = await request(app).get("/api/webhooks/whatsapp")
        .query({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42xyz" });
    assert.equal(res.status, 403);
});

test("unsigned or wrongly signed webhook is 401", async () => {
    mockGraph();
    const payload = messageFrom("250788123456", "MOTA verify 123456");
    assert.equal((await hook(payload, "")).status, 401);
    assert.equal((await hook(payload, sign(JSON.stringify(payload), "other-secret"))).status, 401);
    assert.equal(sent.length, 0);
});

test("matching code from the user's number verifies and activates", async () => {
    const user = await newUser({ phone: "0788123456" });
    const code = await startCode(user);
    mockGraph();
    const res = await hook(messageFrom("250788123456", ` mota  VERIFY ${code} `));
    assert.equal(res.status, 200);
    const stored = await User.findById(user._id).lean();
    assert.equal(stored.isVerified, true);
    assert.equal(stored.isActive, true);
    assert.ok(!stored.waVerifyCodeHash);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /graph\.facebook\.com\/v21\.0\/1234567890\/messages$/);
    assert.deepEqual(sent[0].body, { messaging_product: "whatsapp", to: "250788123456", type: "text", text: { body: SUCCESS } });
});

test("code sent from another number does not verify", async () => {
    const user = await newUser({ phone: "0788123456" });
    const code = await startCode(user);
    mockGraph();
    await hook(messageFrom("250788999999", `MOTA verify ${code}`));
    const stored = await User.findById(user._id).lean();
    assert.equal(stored.isVerified, false);
    assert.ok(stored.waVerifyCodeHash, "the code stays usable from the right phone");
    assert.equal(sent[0].body.to, "250788999999");
    assert.equal(sent[0].body.text.body, MISMATCH);
});

test("expired code gets the expired reply", async () => {
    const user = await newUser({ phone: "0788123456" });
    const code = await startCode(user);
    await User.updateOne({ _id: user._id }, { waVerifyExpiry: new Date(Date.now() - 1000) });
    mockGraph();
    await hook(messageFrom("250788123456", `MOTA verify ${code}`));
    assert.equal((await User.findById(user._id).lean()).isVerified, false);
    assert.equal(sent[0].body.text.body, EXPIRED);
});

test("redelivered message does not verify twice", async () => {
    const user = await newUser({ phone: "0788123456" });
    const code = await startCode(user);
    mockGraph();
    const payload = messageFrom("250788123456", `MOTA verify ${code}`);
    assert.equal((await hook(payload)).status, 200);
    assert.equal((await hook(payload)).status, 200);
    assert.deepEqual(sent.map((s) => s.body.text.body), [SUCCESS, EXPIRED]);
    assert.equal((await User.findById(user._id).lean()).isVerified, true);
});

test("status callbacks get 200 and no reply", async () => {
    mockGraph();
    const res = await hook({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }] });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 0);
});

test("other messages get no reply", async () => {
    mockGraph();
    assert.equal((await hook(messageFrom("250788123456", "hello MOTA"))).status, 200);
    assert.equal(sent.length, 0);
});

test("each outcome is logged", async () => {
    const SmsLog = load("models/SmsLog.js");
    const user = await newUser({ phone: "0788123456" });
    mockGraph();
    await hook(messageFrom("250788123456", `MOTA verify ${await startCode(user)}`));
    const log = await SmsLog.findOne({ phone: "+250788123456" }).lean();
    assert.equal(log.message, SUCCESS);
    assert.equal(log.status, "sent");
    assert.equal(log.type, "otp");
    await SmsLog.deleteMany({});
});
