const adminService = require("../services/adminService");
const userService = require("../services/userService");
const configService = require("../services/configService");
const SystemConfig = require("../models/SystemConfig");
const User = require("../models/User");

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
        // Here admin deletes a user
        await userService.deleteUser(req.params.id);
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
        const { status, remarks } = req.body;
        const validStatuses = ["pending", "correction", "approved"];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: "Invalid status" });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        user.registrationStatus = status;

        if (status === "approved") {
            user.isActive = true;

            // Trigger referral reward (3000 RWF to wallet)
            const Referral = require("../models/Referral");
            const walletService = require("../services/walletService");
            const pendingReferral = await Referral.findOne({ referredUserId: user._id, status: "pending" });
            
            if (pendingReferral) {
                // Reward referrer visually 3000 RWF in their wallet
                await walletService.rewardReferral(pendingReferral.referrerId, 3000);
                pendingReferral.status = "completed";
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

module.exports = {
    getUsersList,
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
};
