const crypto = require("crypto");

// WhatsApp Cloud API. MOTA only ever sends free-form replies to people who just
// messaged us (free inside WhatsApp's 24-hour service window): never templates,
// which are billed per message.
const ENV_KEYS = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_BUSINESS_NUMBER"];
const env = (key) => process.env[key]?.trim() || "";

const isConfigured = () => ENV_KEYS.every((key) => env(key));

/** MOTA's WhatsApp number as digits, for wa.me links. */
const businessNumber = () => env("WHATSAPP_BUSINESS_NUMBER").replace(/\D/g, "");

/**
 * Reply with plain text. Never throws.
 * @param {string} to recipient, digits only (as WhatsApp gives it in `from`)
 * @returns {Promise<boolean>} whether WhatsApp accepted it
 */
const sendText = async (to, body) => {
    try {
        const response = await fetch(`https://graph.facebook.com/v21.0/${env("WHATSAPP_PHONE_NUMBER_ID")}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
        });
        if (!response.ok) {
            console.error(`WhatsApp reply failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
            return false;
        }
        return true;
    } catch (error) {
        console.error("WhatsApp reply failed:", error.message);
        return false;
    }
};

/** Check Meta's X-Hub-Signature-256 header against the exact request bytes. */
const verifySignature = (rawBody, header) => {
    const secret = env("WHATSAPP_APP_SECRET");
    if (!secret || !rawBody || typeof header !== "string" || !header.startsWith("sha256=")) return false;
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
    const given = Buffer.from(header.slice("sha256=".length));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

module.exports = { isConfigured, businessNumber, sendText, verifySignature };
