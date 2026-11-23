const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const path = require("path");
const request = require("supertest");
const { startStack, stopStack, clearDb, ROOT } = require("./harness");

// A mail server that accepts connections and never answers: what a blocked or stalled SMTP port looks like.
let app, silent, fx, sockets = new Set();
const realFetch = global.fetch;
const APP_TIMEOUT = 30000; // the app's axios timeout (services/api.ts)

before(async () => {
    silent = net.createServer((s) => { sockets.add(s); s.on("error", () => {}); });
    await new Promise((r) => silent.listen(0, "127.0.0.1", r));
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(silent.address().port);
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASS = "p";
    delete process.env.BREVO_API_KEY;
    app = await startStack();
    fx = require("./fixtures");
});
after(async () => { global.fetch = realFetch; for (const s of sockets) s.destroy(); silent.close(); await stopStack(); });
beforeEach(async () => { global.fetch = realFetch; delete process.env.BREVO_API_KEY; await clearDb(); });

const unverified = () => fx.makePassenger({ email: "Aline@example.com", isEmailVerified: false, withoutKyc: true });
const brevo = (ok) => {
    const calls = [];
    process.env.BREVO_API_KEY = "test-key";
    process.env.SMTP_FROM_EMAIL = "MOTA <hello@mota.test>";
    global.fetch = async (url, opts) => { calls.push({ url: String(url), opts, body: JSON.parse(opts.body) }); return { ok, status: ok ? 201 : 401, text: async () => "refused" }; };
    return calls;
};

test("resend answers 503 before the app gives up when the mail server is silent", async () => {
    await unverified();
    const start = Date.now();
    const res = await request(app).post("/api/auth/resend-email-otp").send({ email: "Aline@example.com" }).timeout(APP_TIMEOUT);
    assert.ok(Date.now() - start < 20000);
    assert.equal(res.status, 503);
    assert.match(res.body.message, /could not send/i);
});

test("changing email says so when the code could not be sent", async () => {
    const p = await unverified();
    const res = await request(app).post("/api/users/me/contact-change/request").set(p.auth).send({ type: "email", value: "new@example.com" }).timeout(APP_TIMEOUT);
    assert.equal(res.status, 503);
});

test("registration does not wait for the mail server", async () => {
    const start = Date.now();
    const res = await request(app).post("/api/auth/register").send({ firstName: "A", lastName: "B", phone: "+250788123456", nationalId: "1199080012345678", email: "reg@example.com", password: "longpassword1", role: "client" }).timeout(APP_TIMEOUT);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(Date.now() - start < 5000);
});

test("with BREVO_API_KEY the code goes over HTTPS and verifies the email", async () => {
    const { user } = await unverified();
    const calls = brevo(true);
    const res = await request(app).post("/api/auth/resend-email-otp").send({ email: " Aline@example.com " });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(calls[0].opts.headers["api-key"], "test-key");
    assert.deepEqual(calls[0].body.sender, { name: "MOTA", email: "hello@mota.test" });
    assert.deepEqual(calls[0].body.to, [{ email: "Aline@example.com" }]);
    const otp = calls[0].body.htmlContent.match(/>(\d{6})</)[1];
    const ok = await request(app).post("/api/auth/verify-email").send({ email: "Aline@example.com", otp });
    assert.equal(ok.status, 200);
    const User = require(path.join(ROOT, "models/User.js"));
    assert.equal((await User.findById(user._id)).isEmailVerified, true);
});

test("a refused Brevo request is reported, not called sent", async () => {
    await unverified();
    brevo(false);
    const res = await request(app).post("/api/auth/resend-email-otp").send({ email: "Aline@example.com" });
    assert.equal(res.status, 503);
});

test("password reset finds an email stored with capitals", async () => {
    await unverified();
    const calls = brevo(true);
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "Aline@example.com" });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
});
