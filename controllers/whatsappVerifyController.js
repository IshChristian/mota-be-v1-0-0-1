const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const whatsapp = require("../services/whatsappService");

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

module.exports = { start, status, hashCode };
