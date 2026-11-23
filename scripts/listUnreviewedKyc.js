// Read-only: drivers whose account looks approved while their submitted KYC is not, and who reviewed
// each recently approved KYC. Run: node scripts/listUnreviewedKyc.js
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const DriverKyc = require("../models/DriverKyc");

(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const pending = await DriverKyc.find({ status: { $ne: "approved" } }).select("userId status submittedAt").lean();
    const users = await User.find({ _id: { $in: pending.map((k) => k.userId) }, $or: [{ kycLevel: "full" }, { registrationStatus: "approved", isActive: true }] })
        .select("firstName lastName kycLevel registrationStatus isActive").lean();
    console.log(`Accounts approved without an approved KYC (renewals in review also appear here): ${users.length}`);
    for (const u of users) console.log(`- ${u.firstName} ${u.lastName} (${u._id}) level=${u.kycLevel} registration=${u.registrationStatus} active=${u.isActive} KYC=${pending.find((k) => String(k.userId) === String(u._id)).status}`);
    const recent = await DriverKyc.find({ status: "approved" }).sort({ reviewedAt: -1 }).limit(20).populate("userId reviewedBy", "firstName lastName role").lean();
    console.log("\nLatest approved KYC records:");
    for (const k of recent) console.log(`- ${k.userId?.firstName} ${k.userId?.lastName}: ${k.reviewedAt?.toISOString() || "no review date"} by ${k.reviewedBy ? `${k.reviewedBy.firstName} ${k.reviewedBy.lastName} (${k.reviewedBy.role})` : "nobody recorded"}`);
    await mongoose.disconnect();
})().catch((error) => { console.error(error.message); process.exit(1); });
