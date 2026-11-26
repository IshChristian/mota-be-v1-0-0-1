const dotenv = require("dotenv");
const SmsLog = require("../models/SmsLog");

dotenv.config();

// Logging must never turn a sent (or attempted) SMS into a failed request.
// Unknown types (callers pass event names like "rideAccepted") are stored as system_alert.
const SMS_TYPES = new Set(SmsLog.schema.path("type").enumValues);
const logSms = (entry) => SmsLog.create({ ...entry, type: SMS_TYPES.has(entry.type) ? entry.type : "system_alert" })
    .catch((error) => console.error("SMS log write failed:", error.message));

/** The provider only accepts international form: 0791234567 / 250791234567 / 791234567 -> +250791234567. */
const normalizeRwPhone = (phone) => {
    const raw = String(phone || "").replace(/[\s()-]/g, "");
    if (raw.startsWith("+")) return raw;
    if (/^250\d{9}$/.test(raw)) return `+${raw}`;
    if (/^0\d{9}$/.test(raw)) return `+250${raw.slice(1)}`;
    if (/^7\d{8}$/.test(raw)) return `+250${raw}`;
    return raw;
};

const SMS_URL = "https://api.africastalking.com/version1/messaging/bulk";
const ACCEPTED = new Set([100, 101, 102]); // processed, sent, queued

/**
 * Send an SMS via Africa's Talking and log it (with the provider's reason when it fails).
 * @returns {Promise<boolean>} whether the provider accepted the message
 */
const sendSMS = async (phone, message, type = "system_alert") => {
    const to = normalizeRwPhone(phone);
    const fail = async (error) => {
        console.error(`SMS failed: ${error}`);
        await logSms({ phone: to, message, type, status: "failed", error });
        return false;
    };

    const apiKey = process.env.AT_API_KEY?.trim();
    const username = process.env.AT_USERNAME?.trim();
    if (!apiKey) return fail("AT_API_KEY is not set");
    if (!username) return fail("AT_USERNAME is not set");

    try {
        const response = await fetch(SMS_URL, {
            method: "POST",
            headers: { apiKey, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ username, message, senderId: process.env.SMS_SENDER_ID?.trim() || "MOTA", phoneNumbers: [to] }),
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return fail(`${response.status}: ${(await response.text()).slice(0, 300)}`);

        // A refused recipient (bad sender ID, no balance...) still comes back as HTTP 201.
        const data = (await response.json())?.SMSMessageData;
        const recipient = data?.Recipients?.[0];
        if (!recipient) return fail(`${response.status}: ${data?.Message || "no recipient in the provider's answer"}`);
        if (!ACCEPTED.has(Number(recipient.statusCode))) return fail(`${recipient.statusCode}: ${recipient.status}`);
    } catch (error) {
        return fail(`network: ${error.message}`);
    }
    await logSms({ phone: to, message, type, status: "sent" });
    return true;
};

module.exports = { sendSMS, normalizeRwPhone };
