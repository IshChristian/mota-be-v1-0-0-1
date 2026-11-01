const dotenv = require("dotenv");
const SmsLog = require("../models/SmsLog");

dotenv.config();

/**
 * Send an SMS via Pindo API and log it
 * @param {string} phone - Recipient phone number
 * @param {string} message - Message body
 * @param {string} type - SMS type (registration, otp, ride_confirmation, tier_promotion, referral_reward, system_alert)
 * @returns {boolean} Whether SMS was sent successfully
 */
// Logging must never turn a sent (or attempted) SMS into a failed request.
// Unknown types (callers pass event names like "rideAccepted") are stored as system_alert.
const SMS_TYPES = new Set(SmsLog.schema.path("type").enumValues);
const logSms = (entry) => SmsLog.create({ ...entry, type: SMS_TYPES.has(entry.type) ? entry.type : "system_alert" })
    .catch((error) => console.error("SMS log write failed:", error.message));

const sendSMS = async (phone, message, type = "system_alert") => {
    const url = "https://api.pindo.io/v1/sms/";
    const token = process.env.PINDO_API_TOKEN?.trim();

    if (!token) {
        console.error("Missing PINDO_API_TOKEN");
        await logSms({ phone, message, type, status: "failed" });
        return false;
    }

    const data = {
        to: phone,
        text: message,
        sender: process.env.SMS_SENDER_ID || "MOTA",
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`SMS failed: ${response.status}`, errorText);
            await logSms({ phone, message, type, status: "failed" });
            return false;
        }

        const result = await response.json();
        console.log("SMS sent:", result);
        await logSms({ phone, message, type, status: "sent" });
        return true;
    } catch (error) {
        console.error("Error sending SMS:", error.message);
        await logSms({ phone, message, type, status: "failed" });
        return false;
    }
};

module.exports = { sendSMS };
