require("dotenv").config();
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const connectDB = require("../config/database");
const User = require("../models/User");
const Role = require("../models/Role");
const { STAFF_ROLE_TEMPLATES } = require("../constants/staffRoles");
async function run() {
    const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SUPERADMIN_PASSWORD;
    const phone = process.env.SUPERADMIN_PHONE?.trim();
    if (!email || !password || !phone) throw new Error("SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD and SUPERADMIN_PHONE are required");
    if (password.length < 10) throw new Error("SUPERADMIN_PASSWORD must contain at least 10 characters");
    await connectDB();
    const role = await Role.findOneAndUpdate({ name: "superadmin" }, { $set: { description: "System owner with unrestricted access", permissions: STAFF_ROLE_TEMPLATES.superadmin } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    const existingByPhone = await User.findOne({ phone }); const existingByEmail = await User.findOne({ email });
    if (existingByPhone && existingByEmail && String(existingByPhone._id) !== String(existingByEmail._id)) throw new Error("Email and phone belong to different existing accounts");
    const user = existingByEmail || existingByPhone || new User({ firstName: "MOTA", lastName: "Superadmin", phone });
    user.email = email; user.phone = phone; user.password = await bcrypt.hash(password, 12); user.role = "superadmin"; user.roleId = role._id;
    user.isActive = true; user.isVerified = true; user.isEmailVerified = true; user.registrationStatus = "approved";
    await user.save(); console.log(`Superadmin ready: ${user.email}`); await mongoose.connection.close();
}
run().catch(async (error) => { console.error(error.message); await mongoose.connection.close(); process.exitCode = 1; });
