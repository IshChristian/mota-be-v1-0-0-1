const adminService = require("../services/adminService");
const userService = require("../services/userService");
const configService = require("../services/configService");
const SystemConfig = require("../models/SystemConfig");
const User = require("../models/User");
const Role = require("../models/Role");
const bcrypt = require("bcrypt");
const auditService = require("../services/auditService");
const { STAFF_ROLES } = require("../constants/staffRoles");
const Ride = require("../models/Ride");
const SupportCase = require("../models/SupportCase");

const USER_ROLES = ["driver", "agent", "admin", "superadmin", "financial", "caller_support", "client", "manager", "moderator"];
const editableUserFields = ["firstName", "lastName", "phone", "email", "nationalId", "isActive", "isVerified", "isEmailVerified", "kycLevel", "registrationStatus", "registrationRemarks", "emergencyContactName", "emergencyContactPhone", "preferredPayment"];
const pickFields = (source, allowed) => allowed.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
    return result;
}, {});
const auditContext = (req) => ({ actorId: req.user.id, actorRole: req.user.role, ipAddress: req.ip });
const publicUser = (user) => user.toObject ? user.toObject({ transform: (_doc, ret) => { delete ret.password; delete ret.twoFactorSecret; delete ret.otpToken; delete ret.emailOtpToken; return ret; } }) : user;

const getUserDetails = async (req, res) => {
    try {
        const user = await userService.getUserById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });
        res.status(200).json({ data: publicUser(user) });
    } catch (error) { res.status(500).json({ message: "Server error", error: error.message }); }
};

const createUserAccount = async (req, res) => {
    try {
        const { firstName, lastName, phone, email, password, role = "client", roleId } = req.body;
        if (!firstName || !lastName || !phone || !password) return res.status(400).json({ message: "First name, last name, phone and password are required" });
        if (!USER_ROLES.includes(role)) return res.status(400).json({ message: "Invalid role" });
        if (password.length < 8) return res.status(400).json({ message: "Password must contain at least 8 characters" });
        if (role === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({ message: "Only a superadmin can create another superadmin" });
        if (await User.exists({ $or: [{ phone }, ...(email ? [{ email: email.toLowerCase() }] : [])] })) return res.status(409).json({ message: "Phone or email is already registered" });
        let selectedRole = null;
        if (roleId) {
            selectedRole = await Role.findById(roleId);
            if (!selectedRole || selectedRole.name !== role) return res.status(400).json({ message: "Role record does not match the selected role" });
        } else if (STAFF_ROLES.includes(role)) selectedRole = await Role.findOne({ name: role });
        const user = await User.create({ ...pickFields(req.body, editableUserFields), firstName, lastName, phone, email: email?.toLowerCase(), role, roleId: selectedRole?._id, password: await bcrypt.hash(password, 12) });
        await auditService.log({ ...auditContext(req), action: "user_created", targetType: "User", targetId: user._id, metadata: { after: publicUser(user) } });
        res.status(201).json({ message: "User created", data: publicUser(user) });
    } catch (error) { res.status(error.code === 11000 ? 409 : 500).json({ message: error.code === 11000 ? "Phone, email or national ID already exists" : "Server error", error: error.message }); }
};

const updateUserAccount = async (req, res) => {
    try {
        const before = await User.findById(req.params.id);
        if (!before) return res.status(404).json({ message: "User not found" });
        const updates = pickFields(req.body, editableUserFields);
        if (updates.email) updates.email = updates.email.toLowerCase();
        if (req.params.id === req.user.id && updates.isActive === false) return res.status(400).json({ message: "You cannot deactivate your own account" });
        if (before.role === "superadmin" && updates.isActive === false && await User.countDocuments({ role: "superadmin", isActive: true }) <= 1) return res.status(409).json({ message: "The last active superadmin cannot be deactivated" });
        const user = await userService.updateUser(req.params.id, updates);
        await auditService.log({ ...auditContext(req), action: "user_updated", targetType: "User", targetId: user._id, metadata: { before: publicUser(before), changes: updates } });
        res.status(200).json({ message: "User updated", data: publicUser(user) });
    } catch (error) { res.status(error.code === 11000 ? 409 : 500).json({ message: error.code === 11000 ? "Phone, email or national ID already exists" : "Server error", error: error.message }); }
};

const assignUserRole = async (req, res) => {
    try {
        const { role, roleId } = req.body;
        if (!USER_ROLES.includes(role)) return res.status(400).json({ message: "Invalid role" });
        if (role === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({ message: "Only a superadmin can assign the superadmin role" });
        const before = await User.findById(req.params.id);
        if (!before) return res.status(404).json({ message: "User not found" });
        if (req.params.id === req.user.id && before.role !== role) return res.status(400).json({ message: "You cannot change your own role" });
        if (before.role === "superadmin" && role !== "superadmin" && await User.countDocuments({ role: "superadmin", isActive: true }) <= 1) return res.status(409).json({ message: "The last active superadmin cannot be demoted" });
        let selectedRole = null;
        if (roleId) selectedRole = await Role.findById(roleId);
        else if (STAFF_ROLES.includes(role)) selectedRole = await Role.findOne({ name: role });
        if (STAFF_ROLES.includes(role) && (!selectedRole || selectedRole.name !== role)) return res.status(400).json({ message: "A matching staff role record is required" });
        const user = await userService.updateUser(req.params.id, { role, roleId: selectedRole?._id || null });
        await auditService.log({ ...auditContext(req), action: "user_role_assigned", targetType: "User", targetId: user._id, metadata: { before: before.role, after: role } });
        res.status(200).json({ message: "Role assigned", data: publicUser(user) });
    } catch (error) { res.status(500).json({ message: "Server error", error: error.message }); }
};

const getRidesList = async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1); const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const filter = req.query.status ? { rideStatus: req.query.status } : {};
        const [data, total] = await Promise.all([Ride.find(filter).populate("passengerId driverId", "firstName lastName phone").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), Ride.countDocuments(filter)]);
        res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) { res.status(500).json({ message: "Server error", error: error.message }); }
};
const cancelRideAsAdmin = async (req, res) => {
    try {
        const ride = await Ride.findById(req.params.id); if (!ride) return res.status(404).json({ message: "Ride not found" });
        if (["completed", "cancelled", "expired"].includes(ride.rideStatus)) return res.status(409).json({ message: `A ${ride.rideStatus} ride cannot be cancelled` });
        const before = ride.rideStatus; ride.rideStatus = "cancelled"; ride.status = "cancelled"; ride.cancelledBy = req.user.id; ride.cancellationReason = String(req.body.reason || "Cancelled by administrator").slice(0, 500); ride.cancelledAt = new Date(); await ride.save();
        await auditService.log({ ...auditContext(req), action: "ride_admin_cancelled", targetType: "Ride", targetId: ride._id, metadata: { before, reason: ride.cancellationReason } });
        res.json({ message: "Ride cancelled", data: ride });
    } catch (error) { res.status(500).json({ message: "Server error", error: error.message }); }
};
const getSupportCases = async (req, res) => { try { const filter = req.query.status ? { status: req.query.status } : {}; const data = await SupportCase.find(filter).populate("customerId assignedTo createdBy", "firstName lastName phone role").sort({ createdAt: -1 }).limit(200); res.json({ data }); } catch (error) { res.status(500).json({ message: "Server error", error: error.message }); } };
const getSupportCaseDetails = async (req, res) => { try { const item = await SupportCase.findById(req.params.id).populate("customerId assignedTo createdBy", "firstName lastName phone role"); if (!item) return res.status(404).json({ message: "Support case not found" }); res.json({ data: item }); } catch (error) { res.status(500).json({ message: "Server error", error: error.message }); } };
const createSupportCase = async (req, res) => { try { const { customerId, subject, description, priority = "normal", assignedTo } = req.body; if (!subject || !description) return res.status(400).json({ message: "Subject and description are required" }); const item = await SupportCase.create({ customerId, subject, description, priority, assignedTo, createdBy: req.user.id }); await auditService.log({ ...auditContext(req), action: "support_case_created", targetType: "SupportCase", targetId: item._id, metadata: { subject, priority } }); res.status(201).json({ message: "Support case created", data: item }); } catch (error) { res.status(400).json({ message: error.message }); } };
const updateSupportCase = async (req, res) => { try { const allowed = pickFields(req.body, ["subject", "description", "priority", "status", "assignedTo", "resolution"]); const before = await SupportCase.findById(req.params.id); if (!before) return res.status(404).json({ message: "Support case not found" }); if (["resolved", "closed"].includes(allowed.status) && !allowed.resolution && !before.resolution) return res.status(400).json({ message: "Resolution is required before resolving or closing a case" }); const item = await SupportCase.findByIdAndUpdate(req.params.id, allowed, { new: true, runValidators: true }); await auditService.log({ ...auditContext(req), action: "support_case_updated", targetType: "SupportCase", targetId: item._id, metadata: { changes: allowed } }); res.json({ message: "Support case updated", data: item }); } catch (error) { res.status(400).json({ message: error.message }); } };
const deleteSupportCase = async (req, res) => { try { const item = await SupportCase.findByIdAndDelete(req.params.id); if (!item) return res.status(404).json({ message: "Support case not found" }); await auditService.log({ ...auditContext(req), action: "support_case_deleted", targetType: "SupportCase", targetId: item._id, metadata: { subject: item.subject } }); res.json({ message: "Support case deleted" }); } catch (error) { res.status(500).json({ message: "Server error", error: error.message }); } };

const getUsersList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await userService.getUsers({}, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const banUserAccount = async (req, res) => {
    try {
        const user = await adminService.banUser(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ message: "User banned successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const unbanUserAccount = async (req, res) => {
    try {
        const user = await adminService.unbanUser(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ message: "User unbanned successfully", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const deleteUserAccount = async (req, res) => {
    try {
        if (req.params.id === req.user.id) return res.status(400).json({ message: "You cannot delete your own account" });
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.role === "superadmin" && await User.countDocuments({ role: "superadmin", isActive: true }) <= 1) return res.status(409).json({ message: "The last active superadmin cannot be deleted" });
        await userService.deleteUser(req.params.id);
        await auditService.log({ ...auditContext(req), action: "user_deleted", targetType: "User", targetId: user._id, metadata: { before: publicUser(user) } });
        res.status(200).json({ message: "User account deleted entirely" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getStats = async (req, res) => {
    try {
        const stats = await adminService.getSystemStats();
        res.status(200).json({ data: stats });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateSystemConfig = async (req, res) => {
    try {
        const { key, value, description } = req.body;
        if (!key || value === undefined) {
            return res.status(400).json({ message: "Key and value are required" });
        }
        const config = await configService.setConfig(key, value, description, req.user.id);
        res.status(200).json({ message: "System configuration updated", data: config });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getSystemConfigs = async (req, res) => {
    try {
        const configs = await SystemConfig.find({}).populate("updatedBy", "firstName lastName");
        res.status(200).json({ data: configs });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// ─── NEW ADMIN ROUTES ─────────────────────────────────────────────────────

const getDriversList = async (req, res) => {
    try {
        const { page = 1, limit = 20, search } = req.query;
        const filters = search ? { $or: [{ firstName: new RegExp(search, "i") }, { lastName: new RegExp(search, "i") }, { phone: new RegExp(search, "i") }] } : {};
        const result = await adminService.getDrivers(filters, parseInt(page), parseInt(limit));
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getDriverDetails = async (req, res) => {
    try {
        const driver = await userService.getUserById(req.params.id);
        const DriverProfile = require("../models/DriverProfile");
        const profile = await DriverProfile.findOne({ driverId: req.params.id });
        res.status(200).json({ user: driver, profile });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateUserStatus = async (req, res) => {
    try {
        const { isActive } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
        res.status(200).json({ message: "User status updated", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const verifyUser = async (req, res) => {
    try {
        const user = await User.findByIdAndUpdate(req.params.id, { isVerified: true }, { new: true });
        res.status(200).json({ message: "User verified manually", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateKYC = async (req, res) => {
    try {
        const { kycLevel } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { kycLevel }, { new: true });
        res.status(200).json({ message: "KYC level updated", data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getAgentsRegistrations = async (req, res) => {
    try {
        const stats = await adminService.getAgentsStats();
        res.status(200).json({ data: stats });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const approveFine = async (req, res) => {
    try {
        const { id, status, amount } = req.body; // id = fine _id, status = 'approved' or 'rejected'
        const Fine = require("../models/Fine");
        const User = require("../models/User");
        const { sendSMS } = require("../services/smsService");

        const fine = await Fine.findById(id);
        if (!fine) return res.status(404).json({ message: "Fine not found" });

        let smsMessage = "";

        if (status === "approved") {
            const finalAmount = amount || fine.amount;
            if (finalAmount <= 0) return res.status(400).json({ message: "Amount must be greater than 0 for approval" });

            const interestRate = await configService.getConfig("fine_interest_rate", 0.05);
            const totalWithInterest = Math.round(finalAmount * (1 + interestRate));

            fine.status = "approved";
            fine.amount = finalAmount;
            fine.interestRate = interestRate;
            fine.totalAmountWithInterest = totalWithInterest;
            fine.reviewedBy = req.user.id;
            fine.reviewedAt = Date.now();
            await fine.save();
            smsMessage = `MOTA: Fine ${fine.fineId} approved. Amount: ${finalAmount} RWF. Total with interest: ${totalWithInterest} RWF.`;
        } else {
            fine.status = status;
            fine.reviewedBy = req.user.id;
            fine.reviewedAt = Date.now();
            await fine.save();
            smsMessage = `MOTA: Your fine request ${fine.fineId} was rejected by admin.`;
        }

        const driverUser = await User.findById(fine.driverId);
        if (driverUser && driverUser.phone) {
            await sendSMS(driverUser.phone, smsMessage, "fine_review");
        }

        res.status(200).json({ message: `Fine ${status}`, data: fine });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getPendingFineRequests = async (req, res) => {
    try {
        const Fine = require("../models/Fine");
        const pendingFines = await Fine.find({ status: "pending" })
            .populate("driverId", "firstName lastName phone nationalId")
            .sort({ createdAt: -1 });

        res.status(200).json({ data: pendingFines });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateFinancialSettings = async (req, res) => {
    try {
        const {
            registration_fee, agent_registration_fee, ride_commission_percentage,
            cash_out_fee_percentage, agent_cash_in_fee_percentage,
            referral_reward_amount, fine_loan_interest_rate,
            fine_loan_max_amount, fine_loan_auto_repayment_percentage,
            fine_loan_max_duration_days,
            tier_bronze_rides, tier_silver_rides, tier_gold_rides,
            tier_platinum_rides, tier_gorilla_rides
        } = req.body;
        const updates = [];

        // Financial settings
        if (registration_fee !== undefined) updates.push(configService.setConfig("registration_fee", registration_fee, "Driver registration fee", req.user.id));
        if (agent_registration_fee !== undefined) updates.push(configService.setConfig("agent_registration_fee", agent_registration_fee, "Agent registration fee", req.user.id));
        if (ride_commission_percentage !== undefined) updates.push(configService.setConfig("ride_commission_percentage", ride_commission_percentage, "Ride commission %", req.user.id));
        if (cash_out_fee_percentage !== undefined) updates.push(configService.setConfig("cash_out_fee_percentage", cash_out_fee_percentage, "Cash-out fee %", req.user.id));
        if (agent_cash_in_fee_percentage !== undefined) updates.push(configService.setConfig("agent_cash_in_fee_percentage", agent_cash_in_fee_percentage, "Agent cash-in fee %", req.user.id));
        if (referral_reward_amount !== undefined) updates.push(configService.setConfig("referral_reward_amount", referral_reward_amount, "Referral reward amount", req.user.id));

        // Loan settings
        if (fine_loan_interest_rate !== undefined) updates.push(configService.setConfig("fine_loan_interest_rate", fine_loan_interest_rate, "Fine loan interest rate %", req.user.id));
        if (fine_loan_max_amount !== undefined) updates.push(configService.setConfig("fine_loan_max_amount", fine_loan_max_amount, "Max loan amount", req.user.id));
        if (fine_loan_auto_repayment_percentage !== undefined) updates.push(configService.setConfig("fine_loan_auto_repayment_percentage", fine_loan_auto_repayment_percentage, "Loan auto-repayment %", req.user.id));
        if (fine_loan_max_duration_days !== undefined) updates.push(configService.setConfig("fine_loan_max_duration_days", fine_loan_max_duration_days, "Max loan duration days", req.user.id));

        // Tier thresholds
        if (tier_bronze_rides !== undefined) updates.push(configService.setConfig("tier_bronze_rides", tier_bronze_rides, "Bronze tier rides required (lifetime)", req.user.id));
        if (tier_silver_rides !== undefined) updates.push(configService.setConfig("tier_silver_rides", tier_silver_rides, "Silver tier rides required (lifetime)", req.user.id));
        if (tier_gold_rides !== undefined) updates.push(configService.setConfig("tier_gold_rides", tier_gold_rides, "Gold tier rides required (lifetime)", req.user.id));
        if (tier_platinum_rides !== undefined) updates.push(configService.setConfig("tier_platinum_rides", tier_platinum_rides, "Platinum tier rides required (lifetime)", req.user.id));
        if (tier_gorilla_rides !== undefined) updates.push(configService.setConfig("tier_gorilla_rides", tier_gorilla_rides, "Gorilla tier rides required (lifetime)", req.user.id));

        if (updates.length === 0) {
            return res.status(400).json({ message: "No valid settings provided" });
        }

        await Promise.all(updates);
        res.status(200).json({ message: `${updates.length} financial settings updated successfully` });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const updateGeneralSettings = async (req, res) => {
    try {
        const { app_name, support_phone, support_email, maintenance_mode } = req.body;
        const updates = [];

        if (app_name !== undefined) updates.push(configService.setConfig("app_name", app_name, "Platform name", req.user.id));
        if (support_phone !== undefined) updates.push(configService.setConfig("support_phone", support_phone, "Support telephone number", req.user.id));
        if (support_email !== undefined) updates.push(configService.setConfig("support_email", support_email, "Support email address", req.user.id));
        if (maintenance_mode !== undefined) updates.push(configService.setConfig("maintenance_mode", maintenance_mode, "System maintenance status", req.user.id));

        await Promise.all(updates);
        res.status(200).json({ message: "General settings updated successfully" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getPendingRegistrations = async (req, res) => {
    try {
        const { page = 1, limit = 20, status = "pending" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const users = await User.find({ registrationStatus: status, role: { $in: ["driver", "agent"] } })
            .skip(skip)
            .limit(parseInt(limit))
            .sort({ createdAt: -1 });

        const total = await User.countDocuments({ registrationStatus: status, role: { $in: ["driver", "agent"] } });

        res.status(200).json({
            data: users,
            pagination: {
                total,
                page: parseInt(page),
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getRegistrationDetails = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        const DriverProfile = require("../models/DriverProfile");
        const profile = await DriverProfile.findOne({ driverId: user._id });

        res.status(200).json({
            user,
            profile: profile || null
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const reviewRegistration = async (req, res) => {
    try {
        const { status, remarks, rejectionReason } = req.body;
        const validStatuses = ["pending", "correction", "approved"];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: "Invalid status" });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        user.registrationStatus = status;
        user.registrationRemarks = status === "approved" ? undefined : (remarks || rejectionReason);

        if (status === "approved") {
            user.isActive = true;

            // Trigger referral reward (3000 RWF to wallet)
            const Referral = require("../models/Referral");
            const walletService = require("../services/walletService");
            const pendingReferral = await Referral.findOne({ referredUserId: user._id, status: "pending" });
            
            if (pendingReferral) {
                // Reward referrer visually 3000 RWF in their wallet
                await walletService.rewardReferral(pendingReferral.referrerId, 3000);
                pendingReferral.status = "successful";
                await pendingReferral.save();
            }

        } else {
            user.isActive = false; // suspend/pending if not approved
        }

        await user.save();

        // Optionally send sms to driver using notificationService
        const { sendSMS } = require("../services/smsService");
        if (status === "approved") {
            await sendSMS(user.phone, `MOTA: Your account has been approved! You can now start using the platform.`, "registration_review");
        } else if (status === "correction") {
            await sendSMS(user.phone, `MOTA: Your registration needs correction. Remarks: ${remarks || 'Please check your app.'}`, "registration_review");
        }

        res.status(200).json({ message: `Registration status updated to ${status}`, data: user });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getPaypackEvents = async (req, res) => {
    try {
        const paymentService = require("../services/paymentService");
        const result = await paymentService.getEvents(req.query);
        if (!result.success) {
            return res.status(500).json({ message: "Paypack API error", error: result.error });
        }
        res.status(200).json(result.data);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const getPaypackTransactions = async (req, res) => {
    try {
        const paymentService = require("../services/paymentService");
        const result = await paymentService.getTransactions(req.query);
        if (!result.success) {
            return res.status(500).json({ message: "Paypack API error", error: result.error });
        }
        res.status(200).json(result.data);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const syncTransactionsWithPaypack = async (req, res) => {
    try {
        const { ref } = req.body;
        const Transaction = require("../models/Transaction");
        const User = require("../models/User");
        const paymentService = require("../services/paymentService");
        const paymentController = require("./paymentController");

        let pendingRefs = [];
        
        if (ref) {
            const tx = await Transaction.findOne({ paypackRef: ref });
            const user = await User.findOne({ registrationPaypackRef: ref });
            if (!tx && !user) return res.status(404).json({ message: "Transaction/Registration not found locally." });
            
            if (tx) pendingRefs.push({ ref: tx.paypackRef, status: tx.status });
            if (user && !user.registrationPaid) pendingRefs.push({ ref: user.registrationPaypackRef, status: "pending" });
        } else {
            // Find all pending wallet transactions
            const pendingTxs = await Transaction.find({ status: "pending", paypackRef: { $ne: null } });
            for (const t of pendingTxs) pendingRefs.push({ ref: t.paypackRef, status: t.status });

            // Find all pending registration payments
            const pendingUsers = await User.find({ registrationPaid: false, registrationPaypackRef: { $ne: null } });
            for (const u of pendingUsers) pendingRefs.push({ ref: u.registrationPaypackRef, status: "pending" });
        }

        let syncedCount = 0;
        const results = [];

        for (const item of pendingRefs) {
            const ppStatusResult = await paymentService.getTransactionStatus(item.ref);
            
            if (ppStatusResult.success && ppStatusResult.data) {
                const realStatus = ppStatusResult.data.status;
                
                // If Paypack status is terminal (successful or failed) and local is still pending
                if (item.status !== realStatus && (realStatus === "successful" || realStatus === "failed")) {
                    const fakeEvent = {
                        ref: ppStatusResult.data.ref,
                        status: realStatus,
                        amount: ppStatusResult.data.amount,
                        kind: ppStatusResult.data.kind
                    };
                    
                    const fakeReq = { body: fakeEvent };
                    const fakeRes = { status: () => ({ json: () => {} }) };
                    
                    // Route it through the official webhook handler so wallet/streak/registration updates run identically
                    await paymentController.handleWebhook(fakeReq, fakeRes);
                    syncedCount++;
                    results.push({ ref: item.ref, previous: item.status, new: realStatus });
                } else {
                    results.push({ ref: item.ref, status: "in_sync" });
                }
            } else {
                results.push({ ref: item.ref, status: "paypack_fetch_error" });
            }
        }

        res.status(200).json({ 
            message: `Synchronization complete. Updated ${syncedCount} out-of-sync transactions.`,
            syncedCount,
            results 
        });

    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getUsersList,
    getUserDetails,
    createUserAccount,
    updateUserAccount,
    assignUserRole,
    getRidesList,
    cancelRideAsAdmin,
    getSupportCases,
    getSupportCaseDetails,
    createSupportCase,
    updateSupportCase,
    deleteSupportCase,
    getDriversList,
    getDriverDetails,
    updateUserStatus,
    verifyUser,
    updateKYC,
    deleteUserAccount,
    getStats,
    getAgentsRegistrations,
    approveFine,
    banUserAccount,
    unbanUserAccount,
    updateSystemConfig,
    getSystemConfigs,
    updateFinancialSettings,
    updateGeneralSettings,
    getPendingFineRequests,
    getPendingRegistrations,
    getRegistrationDetails,
    reviewRegistration,
    getPaypackEvents,
    getPaypackTransactions,
    syncTransactionsWithPaypack,
};
