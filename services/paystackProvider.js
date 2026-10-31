// Paystack (https://paystack.com) mobile-money provider, used when PAYMENT_PROVIDER=paystack.
//
// IMPORTANT: confirm with Paystack that your merchant account can charge and pay
// out in RWF to MTN MoMo / Airtel Money before switching. Provider and bank codes
// differ per country, so they are configuration, not hard-coded.
//
//   PAYSTACK_SECRET_KEY            sk_live_… / sk_test_… (also signs webhooks)
//   PAYSTACK_CURRENCY              default RWF
//   PAYSTACK_MOMO_PROVIDER_MTN     Charge API provider code for MTN numbers (default "mtn")
//   PAYSTACK_MOMO_PROVIDER_AIRTEL  Charge API provider code for Airtel numbers (default "atl")
//   PAYSTACK_BANK_CODE_MTN         Transfer-recipient bank code for MTN MoMo (from GET /bank?currency=RWF&type=mobile_money)
//   PAYSTACK_BANK_CODE_AIRTEL      Same, for Airtel Money
//   PAYSTACK_CUSTOMER_EMAIL_DOMAIN Paystack needs an email per charge; phone@<domain> is used (default customers.mota.rw)
//
// Webhook URL to set in the Paystack dashboard: https://<api>/api/payment/webhook/paystack
const crypto = require("crypto");
const axios = require("axios");

const BASE = "https://api.paystack.co";
const secret = () => process.env.PAYSTACK_SECRET_KEY || "";
const currency = () => process.env.PAYSTACK_CURRENCY || "RWF";
const client = () => axios.create({ baseURL: BASE, timeout: 20000, headers: { Authorization: `Bearer ${secret()}`, "Content-Type": "application/json" } });

/** "+250788123456" / "0788…" → { local: "0788123456", network: "mtn" | "airtel" | null } */
function parsePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    const local = digits.startsWith("250") ? `0${digits.slice(3)}` : digits.startsWith("0") ? digits : `0${digits}`;
    const prefix = local.slice(0, 3);
    const network = ["078", "079"].includes(prefix) ? "mtn" : ["072", "073"].includes(prefix) ? "airtel" : null;
    return { local, network };
}

const newReference = (kind) => `MOTA-${kind}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
// Paystack amounts are in the currency's subunit (×100).
const toSubunits = (amount) => Math.round(Number(amount) * 100);
const STATUS = { success: "successful", failed: "failed", abandoned: "failed", reversed: "failed" };

const configured = () => Boolean(secret());

async function requestCashIn(phone, amount) {
    if (!configured()) return { success: false, error: "PAYSTACK_SECRET_KEY is not configured" };
    const { local, network } = parsePhone(phone);
    if (!network) return { success: false, error: "Only MTN (078/079) and Airtel (072/073) numbers are supported." };
    const provider = network === "mtn" ? (process.env.PAYSTACK_MOMO_PROVIDER_MTN || "mtn") : (process.env.PAYSTACK_MOMO_PROVIDER_AIRTEL || "atl");
    const reference = newReference("IN");
    try {
        const res = await client().post("/charge", {
            email: `${local}@${process.env.PAYSTACK_CUSTOMER_EMAIL_DOMAIN || "customers.mota.rw"}`,
            amount: toSubunits(amount),
            currency: currency(),
            reference,
            mobile_money: { phone: local, provider },
            metadata: { source: "mota" },
        });
        const status = res.data?.data?.status;
        // "pay_offline" = customer approves the prompt on their phone (the normal MoMo case).
        if (status === "send_otp" || status === "send_birthday" || status === "send_pin") {
            return { success: false, error: `Paystack asked for an extra step (${status}) this app doesn't support for mobile money.` };
        }
        return { success: true, data: { ref: reference, status: STATUS[status] || "pending", provider: "paystack", raw: status } };
    } catch (error) {
        console.error("Paystack charge error:", error?.response?.data || error.message);
        return { success: false, error: error?.response?.data?.message || error.message };
    }
}

async function requestCashOut(phone, amount, name = "MOTA driver") {
    if (!configured()) return { success: false, error: "PAYSTACK_SECRET_KEY is not configured" };
    const { local, network } = parsePhone(phone);
    const bankCode = network === "mtn" ? process.env.PAYSTACK_BANK_CODE_MTN : network === "airtel" ? process.env.PAYSTACK_BANK_CODE_AIRTEL : null;
    if (!bankCode) return { success: false, error: `No Paystack bank code configured for ${network || "this"} network (PAYSTACK_BANK_CODE_${(network || "?").toUpperCase()}).` };
    const reference = newReference("OUT");
    try {
        const recipient = await client().post("/transferrecipient", { type: "mobile_money", name, account_number: local, bank_code: bankCode, currency: currency() });
        const recipientCode = recipient.data?.data?.recipient_code;
        if (!recipientCode) return { success: false, error: "Paystack did not return a transfer recipient." };
        const transfer = await client().post("/transfer", { source: "balance", amount: toSubunits(amount), recipient: recipientCode, reference, reason: "MOTA payout" });
        const status = transfer.data?.data?.status;
        if (status === "otp") return { success: false, error: "Paystack transfer OTP is enabled. Disable it in the Paystack dashboard for automatic payouts." };
        return { success: true, data: { ref: reference, status: STATUS[status] || "pending", provider: "paystack", raw: status } };
    } catch (error) {
        console.error("Paystack transfer error:", error?.response?.data || error.message);
        return { success: false, error: error?.response?.data?.message || error.message };
    }
}

async function getTransactionStatus(ref) {
    if (!configured()) return { success: false, error: "PAYSTACK_SECRET_KEY is not configured" };
    try {
        const path = String(ref).startsWith("MOTA-OUT-") ? `/transfer/verify/${encodeURIComponent(ref)}` : `/transaction/verify/${encodeURIComponent(ref)}`;
        const res = await client().get(path);
        const d = res.data?.data || {};
        return { success: true, data: { ref, status: STATUS[d.status] || "pending", amount: d.amount ? d.amount / 100 : undefined, kind: String(ref).startsWith("MOTA-OUT-") ? "CASHOUT" : "CASHIN" } };
    } catch (error) {
        return { success: false, error: error?.response?.data?.message || error.message };
    }
}

/** x-paystack-signature = hex HMAC-SHA512 of the raw body, keyed with the secret key. */
function verifySignature(rawBody, signature) {
    if (!secret() || !rawBody || !signature) return false;
    const expected = crypto.createHmac("sha512", secret()).update(rawBody).digest("hex");
    const a = Buffer.from(String(signature)), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Paystack event → the { ref, status, kind, amount } shape the settlement code already handles. */
function normalizeEvent(body) {
    const event = String(body?.event || "");
    const d = body?.data || {};
    if (!d.reference) return null;
    if (event === "charge.success") return { ref: d.reference, status: "successful", kind: "CASHIN", amount: d.amount / 100 };
    if (event.startsWith("charge.") && d.status === "failed") return { ref: d.reference, status: "failed", kind: "CASHIN", amount: d.amount / 100 };
    if (event === "transfer.success") return { ref: d.reference, status: "successful", kind: "CASHOUT", amount: d.amount / 100 };
    if (event === "transfer.failed" || event === "transfer.reversed") return { ref: d.reference, status: "failed", kind: "CASHOUT", amount: d.amount / 100 };
    return null;
}

module.exports = { configured, requestCashIn, requestCashOut, getTransactionStatus, verifySignature, normalizeEvent, parsePhone };
