const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const SmsLog = require("../models/SmsLog");
const whatsapp = require("../services/whatsappService");
const { normalizeRwPhone } = require("../services/smsService");

const CODE_TTL_MS = 15 * 60 * 1000;
const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

const findUser = async (userId) => (mongoose.isValidObjectId(userId) ? User.findById(userId) : null);

/** POST /api/auth/whatsapp/start { userId } → a wa.me link carrying a fresh 6-digit code. */
const start = async (req, res) => {
    try {
        if (!whatsapp.isConfigured()) return res.status(503).json({ message: "WhatsApp verification is not available right now." });
        const user = await findUser(req.body?.userId);
        if (!user) return res.status(404).json({ message: "User not found." });
        if (user.isVerified) return res.status(400).json({ message: "User is already verified." });

        const code = crypto.randomInt(100000, 1000000).toString();
        const expiresAt = new Date(Date.now() + CODE_TTL_MS);
        user.waVerifyCodeHash = hashCode(code);
        user.waVerifyExpiry = expiresAt;
        await user.save();

        const text = encodeURIComponent(`MOTA verify ${code}`);
        res.status(200).json({ link: `https://wa.me/${whatsapp.businessNumber()}?text=${text}`, expiresAt });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/** GET /api/auth/whatsapp/status?userId= → { verified } and nothing else. */
const status = async (req, res) => {
    try {
        const user = await findUser(req.query.userId);
        if (!user) return res.status(404).json({ message: "User not found." });
        res.status(200).json({ verified: !!user.isVerified });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const REPLY = {
    verified: "✅ Your MOTA number is verified. Go back to the app.",
    mismatch: "This WhatsApp number isn't the phone you signed up with.",
    expired: "That code has expired. Tap Verify with WhatsApp in the app again.",
};
const VERIFY_TEXT = /^\s*mota\s+verify\s+(\d{6})\s*$/i;

/** GET /api/webhooks/whatsapp: Meta's subscription handshake. */
const handshake = (req, res) => {
    const token = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
    if (token && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === token) {
        return res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    }
    res.sendStatus(403);
};

const reply = async (from, outcome) => {
    const message = REPLY[outcome];
    const ok = await whatsapp.sendText(from, message);
    await SmsLog.create({ phone: `+${from}`, message, type: "otp", status: ok ? "sent" : "failed", error: ok ? undefined : `whatsapp: ${outcome} reply not accepted` })
        .catch((error) => console.error("WhatsApp log write failed:", error.message));
};

/** Decide what one "MOTA verify <code>" message means and act on it. */
const handleVerifyMessage = async (from, code) => {
    const hash = hashCode(code);
    const user = await User.findOne({ waVerifyCodeHash: hash, waVerifyExpiry: { $gt: new Date() } });
    if (!user) return reply(from, "expired");
    // The sender's WhatsApp number is the proof: it must be the phone the account was registered with.
    if (normalizeRwPhone(user.phone).replace(/^\+/, "") !== from) return reply(from, "mismatch");

    // Claim the code atomically so a redelivered webhook can't verify (and settle referrals) twice.
    const claimed = await User.findOneAndUpdate(
        { _id: user._id, waVerifyCodeHash: hash },
        { $unset: { waVerifyCodeHash: 1, waVerifyExpiry: 1 } },
        { new: true },
    );
    if (!claimed) return reply(from, "expired");
    await require("./authController").markPhoneVerified(claimed);
    return reply(from, "verified");
};

/** POST /api/webhooks/whatsapp: incoming messages. Always 200 once the signature checks out. */
const receive = async (req, res) => {
    if (!whatsapp.verifySignature(req.rawBody, req.get("X-Hub-Signature-256"))) return res.sendStatus(401);
    try {
        for (const entry of req.body?.entry || []) {
            for (const change of entry.changes || []) {
                for (const message of change.value?.messages || []) {
                    const match = message.type === "text" && VERIFY_TEXT.exec(message.text?.body || "");
                    const from = String(message.from || "").replace(/\D/g, "");
                    if (match && from) await handleVerifyMessage(from, match[1]);
                }
            }
        }
    } catch (error) {
        console.error("WhatsApp webhook failed:", error.message);
    }
    res.sendStatus(200);
};

module.exports = { start, status, handshake, receive, hashCode };
