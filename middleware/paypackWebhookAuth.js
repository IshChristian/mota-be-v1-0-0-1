const crypto = require("crypto");

const safeEqual = (left, right) => {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = (req, res, next) => {
    const secret = process.env.PAYPACK_WEBHOOK_SECRET;
    const signature = req.get("x-paypack-signature");

    // Production must never accept an unsigned payment event. Local
    // development can opt out explicitly while configuring Paypack.
    if (!secret) {
        if (process.env.NODE_ENV !== "production" && process.env.PAYPACK_WEBHOOK_VERIFY === "false") {
            return next();
        }
        return res.status(503).json({ message: "Paypack webhook verification is not configured." });
    }
    if (!signature || !req.rawBody) {
        return res.status(401).json({ message: "Missing Paypack webhook signature." });
    }

    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
    if (!safeEqual(signature, expected)) {
        return res.status(401).json({ message: "Invalid Paypack webhook signature." });
    }
    return next();
};
