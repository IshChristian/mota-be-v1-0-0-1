// SMS delivery through Africa's Talking: numbers are sent in +250 form and the provider's refusal reason is kept in the log.
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { startStack, stopStack } = require("./harness");

let sendSMS, normalizeRwPhone, SmsLog;
const realFetch = global.fetch;
let calls;

before(async () => {
    await startStack();
    process.env.AT_API_KEY = "test-key";
    process.env.AT_USERNAME = "mota";
    process.env.SMS_SENDER_ID = "MOTA";
    ({ sendSMS, normalizeRwPhone } = require("../services/smsService"));
    SmsLog = require("../models/SmsLog");
});
after(async () => { global.fetch = realFetch; await stopStack(); });
afterEach(async () => { global.fetch = realFetch; await SmsLog.deleteMany({}); });

const mockProvider = (status, body) => {
    calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
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

const recipient = (statusCode, status) => ({ SMSMessageData: { Message: "Sent to 1/1", Recipients: [{ statusCode, status, number: "+250791234567", messageId: "ATPid_1" }] } });

test("a local number is sent to Africa's Talking in +250 form", async () => {
    mockProvider(201, recipient(101, "Success"));
    assert.equal(await sendSMS("0791234567", "hello", "otp"), true);
    assert.equal(calls[0].url, "https://api.africastalking.com/version1/messaging/bulk");
    assert.equal(calls[0].headers.apiKey, "test-key");
    assert.deepEqual(calls[0].body, { username: "mota", message: "hello", senderId: "MOTA", phoneNumbers: ["+250791234567"] });
    const log = await SmsLog.findOne();
    assert.equal(log.status, "sent");
    assert.equal(log.error, undefined);
});

test("processed, sent and queued all count as accepted", async () => {
    for (const code of [100, 101, 102]) {
        mockProvider(201, recipient(code, "Success"));
        assert.equal(await sendSMS("0791234567", "hello", "otp"), true);
    }
});

// The API answers HTTP 201 even when it refuses the recipient.
test("a refused recipient inside a 201 answer is a failure with its reason", async () => {
    for (const [code, reason] of [[402, "InvalidSenderId"], [405, "InsufficientBalance"], [403, "InvalidPhoneNumber"]]) {
        mockProvider(201, recipient(code, reason));
        assert.equal(await sendSMS("0791234567", "hello", "otp"), false);
        assert.ok(await SmsLog.findOne({ status: "failed", error: `${code}: ${reason}` }));
    }
});

test("an answer without recipients is a failure with the provider's message", async () => {
    mockProvider(201, { SMSMessageData: { Message: "InvalidSenderId", Recipients: [] } });
    assert.equal(await sendSMS("0791234567", "hello", "otp"), false);
    assert.equal((await SmsLog.findOne()).error, "201: InvalidSenderId");
});

test("a wrong API key (plain-text 401) is stored", async () => {
    calls = [];
    global.fetch = async () => new Response("The supplied authentication is invalid", { status: 401 });
    assert.equal(await sendSMS("0791234567", "hello", "otp"), false);
    assert.equal((await SmsLog.findOne()).error, "401: The supplied authentication is invalid");
});

test("missing settings are recorded and nothing is sent", async () => {
    for (const name of ["AT_API_KEY", "AT_USERNAME"]) {
        const value = process.env[name];
        mockProvider(201, recipient(101, "Success"));
        process.env[name] = "";
        try {
            assert.equal(await sendSMS("+250791234567", "hello", "otp"), false);
        } finally { process.env[name] = value; }
        assert.equal(calls.length, 0);
        assert.ok(await SmsLog.findOne({ error: `${name} is not set` }));
    }
});
