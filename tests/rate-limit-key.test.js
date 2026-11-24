// Behind Render + Cloudflare req.ip is the proxy, so limits must count people, not proxies.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack } = require("./harness");
let app, fx;
before(async () => {
    Object.assign(process.env, { API_RATE_LIMIT_PER_MINUTE: "5", USER_RATE_LIMIT_PER_MINUTE: "10", AUTH_RATE_LIMIT_PER_15_MIN: "3", AUTH_IP_RATE_LIMIT_PER_15_MIN: "6" });
    app = await startStack(); fx = require("./fixtures");
});
after(stopStack);
const me = (auth, ip) => request(app).get("/api/users/me").set(auth).set("CF-Connecting-IP", ip);

test("one busy driver does not lock out another on the same network", async () => {
    const [a, b] = [await fx.makeDriver(), await fx.makeDriver()];
    let last;
    for (let i = 0; i < 11; i++) last = await me(a.auth, "10.0.0.1");
    assert.equal(last.status, 429);
    assert.equal((await me(b.auth, "10.0.0.1")).status, 200);
});
test("a made-up token is counted by address, not trusted as a person", async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await me({ Authorization: `Bearer fake${i}` }, "10.0.0.2");
    assert.equal(last.status, 429);
});
test("email codes: limited per account, and per address overall", async () => {
    const send = (email, ip) => request(app).post("/api/auth/resend-email-otp").set("CF-Connecting-IP", ip).send({ email });
    for (let i = 0; i < 3; i++) assert.equal((await send("a@example.com", "10.0.0.3")).status, 404);
    assert.equal((await send("A@example.com ", "10.0.0.3")).status, 429);
    assert.equal((await send("b@example.com", "10.0.0.3")).status, 404, "another person behind the same address");
    assert.equal((await send("c@example.com", "10.0.0.3")).status, 429, "address total");
    assert.equal((await send("c@example.com", "10.0.0.4")).status, 404);
});
