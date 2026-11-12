// SMS delivery through Pindo: numbers are sent in +250 form and Pindo's refusal reason is kept in the log.
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { startStack, stopStack } = require("./harness");

let sendSMS, normalizeRwPhone, SmsLog;
const realFetch = global.fetch;
let calls;

before(async () => {
    await startStack();
    process.env.PINDO_API_TOKEN = "test-token";
    process.env.SMS_SENDER_ID = "MOTA";
    ({ sendSMS, normalizeRwPhone } = require("../services/smsService"));
    SmsLog = require("../models/SmsLog");
});
after(async () => { global.fetch = realFetch; await stopStack(); });
afterEach(async () => { global.fetch = realFetch; await SmsLog.deleteMany({}); });

const mockPindo = (status, body) => {
    calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
};

test("Rwandan numbers are normalised to +250 form", () => {
    assert.equal(normalizeRwPhone("0791234567"), "+250791234567");
    assert.equal(normalizeRwPhone("250791234567"), "+250791234567");
    assert.equal(normalizeRwPhone(" +250 791 234 567 "), "+250791234567");
    assert.equal(normalizeRwPhone("791234567"), "+250791234567");
    assert.equal(normalizeRwPhone("+254712345678"), "+254712345678");
});

test("a local number is sent to Pindo in +250 form", async () => {
    mockPindo(201, { sms_id: 1 });
    assert.equal(await sendSMS("0791234567", "hello", "otp"), true);
    assert.equal(calls[0].body.to, "+250791234567");
    assert.equal(calls[0].body.sender, "MOTA");
    const log = await SmsLog.findOne();
    assert.equal(log.status, "sent");
    assert.equal(log.error, undefined);
});

test("Pindo's refusal reason is stored on the failed log entry", async () => {
    mockPindo(409, { error: "PindoTest sender id is not allowed in Rwanda", status: 409 });
    assert.equal(await sendSMS("+250791234567", "hello", "otp"), false);
    const log = await SmsLog.findOne();
    assert.equal(log.status, "failed");
    assert.equal(log.error, "409: PindoTest sender id is not allowed in Rwanda");
});

test("a missing token is recorded as the failure reason", async () => {
    const token = process.env.PINDO_API_TOKEN;
    delete process.env.PINDO_API_TOKEN;
    try {
        assert.equal(await sendSMS("+250791234567", "hello", "otp"), false);
    } finally { process.env.PINDO_API_TOKEN = token; }
    assert.equal((await SmsLog.findOne()).error, "PINDO_API_TOKEN is not set");
});
