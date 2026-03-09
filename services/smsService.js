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
const sendSMS = async (phone, message, type = "system_alert") => {
    const url = "https://api.pindo.io/v1/sms/";
    const token = process.env.PINDO_API_TOKEN?.trim();

    if (!token) {
        console.error("Missing PINDO_API_TOKEN");
        await SmsLog.create({ phone, message, type, status: "failed" });
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
            await SmsLog.create({ phone, message, type, status: "failed" });
            return false;
        }

        const result = await response.json();
        console.log("SMS sent:", result);
        await SmsLog.create({ phone, message, type, status: "sent" });
        return true;
    } catch (error) {
        console.error("Error sending SMS:", error.message);
        await SmsLog.create({ phone, message, type, status: "failed" });
        return false;
    }
};

module.exports = { sendSMS };
