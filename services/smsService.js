const dotenv = require("dotenv");
const SmsLog = require("../models/SmsLog");

dotenv.config();

// Logging must never turn a sent (or attempted) SMS into a failed request.
// Unknown types (callers pass event names like "rideAccepted") are stored as system_alert.
const SMS_TYPES = new Set(SmsLog.schema.path("type").enumValues);
const logSms = (entry) => SmsLog.create({ ...entry, type: SMS_TYPES.has(entry.type) ? entry.type : "system_alert" })
    .catch((error) => console.error("SMS log write failed:", error.message));

/** Pindo only accepts international form: 0791234567 / 250791234567 / 791234567 -> +250791234567. */
const normalizeRwPhone = (phone) => {
    const raw = String(phone || "").replace(/[\s()-]/g, "");
    if (raw.startsWith("+")) return raw;
    if (/^250\d{9}$/.test(raw)) return `+${raw}`;
    if (/^0\d{9}$/.test(raw)) return `+250${raw.slice(1)}`;
    if (/^7\d{8}$/.test(raw)) return `+250${raw}`;
    return raw;
};

const providerError = (status, text) => {
    try {
        const body = JSON.parse(text);
        return `${status}: ${body.error || body.message || text}`;
    } catch {
        return `${status}: ${String(text).slice(0, 300)}`;
    }
};

/**
 * Send an SMS via Pindo and log it (with Pindo's reason when it fails).
 * @returns {Promise<boolean>} whether Pindo accepted the message
 */
const sendSMS = async (phone, message, type = "system_alert") => {
    const url = "https://api.pindo.io/v1/sms/";
    const token = process.env.PINDO_API_TOKEN?.trim();
    const to = normalizeRwPhone(phone);

    if (!token) {
        console.error("Missing PINDO_API_TOKEN");
        await logSms({ phone: to, message, type, status: "failed", error: "PINDO_API_TOKEN is not set" });
        return false;
    }

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ to, text: message, sender: process.env.SMS_SENDER_ID?.trim() || "MOTA" }),
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            const error = providerError(response.status, await response.text());
            console.error(`SMS failed: ${error}`);
            await logSms({ phone: to, message, type, status: "failed", error });
            return false;
        }

        await response.json().catch(() => null);
        await logSms({ phone: to, message, type, status: "sent" });
        return true;
    } catch (error) {
        console.error("Error sending SMS:", error.message);
        await logSms({ phone: to, message, type, status: "failed", error: `network: ${error.message}` });
        return false;
    }
};

module.exports = { sendSMS, normalizeRwPhone };
