// One ride decision at a time per person, across requests and server instances. Without it
// "is this driver free?" and "give them the ride" can interleave and book a driver twice.
const crypto = require("crypto");
const User = require("../models/User");

const HOLD_MS = 15000; // a crashed holder frees itself
const WAIT_MS = 5000;

const withRideLock = async (userId, fn) => {
    const token = crypto.randomUUID();
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const now = new Date();
        const held = await User.updateOne(
            { _id: userId, $or: [{ "rideLock.until": { $exists: false } }, { "rideLock.until": { $lte: now } }] },
            { $set: { rideLock: { token, until: new Date(now.getTime() + HOLD_MS) } } },
            { timestamps: false }
        );
        if (held.modifiedCount === 1) break;
        if (Date.now() > deadline) throw Object.assign(new Error("Another ride action is still in progress. Please try again."), { status: 409 });
        await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 60));
    }
    try { return await fn(); }
    finally { await User.updateOne({ _id: userId, "rideLock.token": token }, { $unset: { rideLock: 1 } }, { timestamps: false }).catch((error) => console.error("Ride lock release failed:", error.message)); }
};

module.exports = { withRideLock };
