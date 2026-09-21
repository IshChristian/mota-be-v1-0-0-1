const userService = require("../services/userService");
const uploadService = require("../services/uploadService");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const User = require("../models/User");
const Ride = require("../models/Ride");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const Loan = require("../models/Loan");
const { sendSMS } = require("../services/smsService");
const { sendEmail } = require("../services/notificationService");

const getUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await userService.getUsers({}, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getUser = async (req, res) => {
    try {
        const user = await userService.getUserById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getMe = async (req, res) => {
    try {
        const user = await userService.getUserById(req.user.id);
        res.status(200).json({ data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateMe = async (req, res) => {
    try {
        const {
            firstName, lastName, emergencyContactName,
            emergencyContactPhone, preferredPayment,
        } = req.body;
        if (preferredPayment && !["CASH", "MOMO", "CARD"].includes(preferredPayment)) {
            return res.status(400).json({ message: "preferredPayment must be CASH, MOMO, or CARD" });
        }
        // Don't allow updating sensitive fields here directly
        const updates = {
            firstName, lastName, emergencyContactName,
            emergencyContactPhone, preferredPayment,
        };
        if (emergencyContactName && emergencyContactPhone && preferredPayment) {
            updates.passengerProfileCompleted = true;
        }
        Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);
        const user = await userService.updateUser(req.user.id, updates);
        res.status(200).json({ message: "Profile updated", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const uploadAvatar = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "Avatar file required" });

        // Multer-storage-cloudinary directly processes and returns the URL in req.file.path
        const avatarUrl = req.file.path;

        // Update User profile with just the avatar link (pure URL)
        const user = await userService.updateUser(req.user.id, { avatarUrl });

        res.status(200).json({ message: "Avatar uploaded successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const deleteAccount = async (req, res) => {
    try {
        const password = String(req.body.password || "");
        const user = await User.findById(req.user.id).select("+password +tokenVersion");
        if (!user?.password || !await bcrypt.compare(password, user.password)) return res.status(401).json({ message: "Password confirmation failed" });
        const [activeRide, activeLoan, wallet] = await Promise.all([
            Ride.exists({ $or: [{ passengerId: user._id }, { driverId: user._id }], rideStatus: { $nin: ["completed", "cancelled", "expired"] } }),
            Loan.exists({ driverId: user._id, loanStatus: { $in: ["pending", "active", "defaulted"] } }),
            Wallet.findOne({ driverId: user._id }).lean(),
        ]);
        if (activeRide) return res.status(409).json({ message: "Complete or cancel your active ride before deleting the account" });
        if (activeLoan) return res.status(409).json({ message: "Resolve active loans before deleting the account" });
        if ((wallet?.balance || 0) > 0 || (wallet?.heldBalance || 0) > 0) return res.status(409).json({ message: "Withdraw available funds and resolve held funds before deleting the account" });
        const suffix = `${user._id}.${Date.now()}`;
        user.firstName = "Deleted"; user.lastName = "User";
        user.phone = `deleted.${suffix}`; user.email = `deleted.${suffix}@invalid.local`;
        user.nationalId = undefined; user.avatarUrl = undefined; user.password = undefined;
        user.pushTokens = []; user.isActive = false; user.deletedAt = new Date();
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();
        res.status(200).json({ message: "Account deleted and personal profile anonymized" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (typeof newPassword !== "string" || newPassword.length < 10) return res.status(400).json({ message: "New password must contain at least 10 characters" });
        const user = await User.findById(req.user.id).select("+password +tokenVersion");
        if (!user?.password || !await bcrypt.compare(String(currentPassword || ""), user.password)) return res.status(401).json({ message: "Current password is incorrect" });
        if (await bcrypt.compare(newPassword, user.password)) return res.status(400).json({ message: "New password must be different" });
        user.password = await bcrypt.hash(newPassword, 12); user.tokenVersion = (user.tokenVersion || 0) + 1; await user.save();
        res.json({ message: "Password changed. Please sign in again on all devices." });
    } catch (error) { res.status(500).json({ message: "Unable to change password" }); }
};

const exportMyData = async (req, res) => {
    try {
        const [user, rides, transactions] = await Promise.all([
            User.findById(req.user.id).select("-password -otpToken -emailOtpToken -twoFactorSecret -pushTokens").lean(),
            Ride.find({ $or: [{ passengerId: req.user.id }, { driverId: req.user.id }] }).sort({ createdAt: -1 }).lean(),
            Transaction.find({ $or: [{ userId: req.user.id }, { driverId: req.user.id }, { agentId: req.user.id }] }).sort({ createdAt: -1 }).lean(),
        ]);
        res.setHeader("Content-Disposition", `attachment; filename=mota-data-${req.user.id}.json`);
        res.json({ exportedAt: new Date().toISOString(), user, rides, transactions });
    } catch (error) { res.status(500).json({ message: "Unable to export account data" }); }
};

const requestContactChange = async (req, res) => {
    try {
        const type = req.body.type; const value = String(req.body.value || "").trim().toLowerCase();
        if (!['phone','email'].includes(type) || !value) return res.status(400).json({ message: "Valid type and value are required" });
        if (await User.exists(type === 'phone' ? { phone: value } : { email: value })) return res.status(409).json({ message: `That ${type} is already registered` });
        const otp = String(crypto.randomInt(100000, 1000000)); const user = await User.findById(req.user.id).select("+pendingPhone +pendingEmail +contactChangeOtpHash +contactChangeExpiresAt");
        user.pendingPhone = type === 'phone' ? value : undefined; user.pendingEmail = type === 'email' ? value : undefined;
        user.contactChangeOtpHash = crypto.createHash('sha256').update(otp).digest('hex'); user.contactChangeExpiresAt = new Date(Date.now() + 10 * 60 * 1000); await user.save();
        if (type === 'phone') await sendSMS(value, `MOTA contact change code: ${otp}`, 'contact_change'); else await sendEmail(value, 'Confirm your MOTA email', `Your MOTA confirmation code is ${otp}`, `<p>Your MOTA confirmation code is <strong>${otp}</strong>. It expires in 10 minutes.</p>`);
        res.json({ message: `Confirmation code sent to the new ${type}` });
    } catch (error) { res.status(500).json({ message: "Unable to request contact change" }); }
};

const verifyContactChange = async (req, res) => {
    try {
        const hash = crypto.createHash('sha256').update(String(req.body.otp || '')).digest('hex');
        const user = await User.findById(req.user.id).select("+pendingPhone +pendingEmail +contactChangeOtpHash +contactChangeExpiresAt");
        if (!user || user.contactChangeOtpHash !== hash || !user.contactChangeExpiresAt || user.contactChangeExpiresAt <= new Date()) return res.status(400).json({ message: "Invalid or expired confirmation code" });
        if (user.pendingPhone) { user.phone = user.pendingPhone; user.isVerified = true; }
        if (user.pendingEmail) { user.email = user.pendingEmail; user.isEmailVerified = true; }
        user.pendingPhone = undefined; user.pendingEmail = undefined; user.contactChangeOtpHash = undefined; user.contactChangeExpiresAt = undefined; await user.save();
        res.json({ message: "Contact information updated", data: await userService.getUserById(user._id) });
    } catch (error) { res.status(error.code === 11000 ? 409 : 500).json({ message: error.code === 11000 ? "That contact is already registered" : "Unable to update contact information" }); }
};

const assignRole = async (req, res) => {
    try {
        const { roleId } = req.body;
        const user = await userService.assignRole(req.params.id, roleId);

        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ message: "Role assigned successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getUsers,
    getUser,
    getMe,
    updateMe,
    uploadAvatar,
    deleteAccount,
    changePassword,
    exportMyData,
    requestContactChange,
    verifyContactChange,
    assignRole,
};
