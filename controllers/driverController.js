const mongoose = require("mongoose");
const DriverProfile = require("../models/DriverProfile");
const User = require("../models/User");
const Ride = require("../models/Ride");
const Fine = require("../models/Fine");
const { getStreakInfo, DAILY_TARGET } = require("../services/streakService");
const { getTierInfo } = require("../services/tierService");
const Referral = require("../models/Referral");
const walletService = require("../services/walletService");
const { sendEmail } = require("../services/notificationService");
const { sendSMS } = require("../services/smsService");
const configService = require("../services/configService");

const DEFAULT_FINE_INTEREST_RATE = 0.05; // 5%

/**
 * Create driver profile
 * POST /api/driver/create-profile
 */
const createProfile = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { plateNumber, cooperativeName, nid, insuranceAttachment, permitAttachment, permitId } = req.body;

        if (!plateNumber || !nid || !insuranceAttachment || !permitAttachment || !permitId) {
            return res.status(400).json({
                message: "plateNumber, nid, insuranceAttachment, permitAttachment, and permitId are required",
            });
        }

        // Check if profile already exists
        const existingProfile = await DriverProfile.findOne({ driverId });
        if (existingProfile) {
            return res.status(400).json({ message: "Driver profile already exists" });
        }

        // Check for duplicate plate number or NID
        const duplicateCheck = await DriverProfile.findOne({
            $or: [{ plateNumber }, { nid }, { permitId }],
        });
        if (duplicateCheck) {
            return res.status(400).json({ message: "Plate number, NID, or permit ID already registered" });
        }

        const profile = new DriverProfile({
            driverId,
            plateNumber,
            cooperativeName,
            nid,
            insuranceAttachment,
            permitAttachment,
            permitId,
        });

        await profile.save();

        // Update KYC level when profile is submitted
        await User.findByIdAndUpdate(driverId, { kycLevel: "full" });

        res.status(201).json({
            message: "Driver profile created successfully",
            profile,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get driver dashboard
 * GET /api/driver/dashboard
 */
const getDashboard = async (req, res) => {
    try {
        const driverId = req.user.id;

        // Get tier info
        const tierInfo = await getTierInfo(driverId);

        // Get streak info
        const streakInfo = await getStreakInfo(driverId);

        // Get rides this month
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        const ridesMonth = await Ride.countDocuments({
            driverId,
            createdAt: { $gte: startOfMonth, $lte: endOfMonth },
        });

        // Get wallet balance
        const profile = await DriverProfile.findOne({ driverId });
        const wallet = profile ? profile.wallet : 0;

        // Get referral count
        const referralCount = await Referral.countDocuments({
            referrerId: driverId,
            status: "completed",
        });

        res.status(200).json({
            tier: tierInfo.tier,
            multiplier: tierInfo.multiplier,
            ridesToday: streakInfo.todayRideCount,
            target: DAILY_TARGET,
            ridesMonth,
            streak: streakInfo.currentStreak,
            longestStreak: streakInfo.longestStreak,
            wallet,
            referrals: referralCount,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get driver profile
 * GET /api/driver/profile
 */
const getProfile = async (req, res) => {
    try {
        const driverId = req.user.id;
        const user = await User.findById(driverId).select("-password -otpToken");
        const profile = await DriverProfile.findOne({ driverId });

        if (!profile) {
            return res.status(404).json({ message: "Driver profile not found. Please create one." });
        }

        res.status(200).json({ user, profile });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Update driver profile
 * PUT /api/driver/update-profile
 */
const updateProfile = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { plateNumber, cooperativeName, insuranceAttachment, permitAttachment, permitId } = req.body;

        const profile = await DriverProfile.findOneAndUpdate(
            { driverId },
            {
                ...(plateNumber && { plateNumber }),
                ...(cooperativeName && { cooperativeName }),
                ...(insuranceAttachment && { insuranceAttachment }),
                ...(permitAttachment && { permitAttachment }),
                ...(permitId && { permitId }),
            },
            { new: true }
        );

        if (!profile) {
            return res.status(404).json({ message: "Driver profile not found" });
        }

        res.status(200).json({ message: "Profile updated successfully", profile });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get ride history for driver
 * GET /api/driver/rides
 */
const getRideHistory = async (req, res) => {
    try {
        const driverId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const rides = await Ride.find({ driverId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Ride.countDocuments({ driverId });

        res.status(200).json({
            rides,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Pay driver fine
 * POST /api/driver/pay-fine
 */
const payFineApi = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { fineId, paymentAmount } = req.body;

        const fine = await Fine.findById(fineId);
        if (!fine) return res.status(404).json({ message: "Fine not found" });
        if (fine.status === "paid") return res.status(400).json({ message: "Fine is already fully paid" });
        if (fine.driverId.toString() !== driverId.toString()) {
            return res.status(403).json({ message: "Unauthorized to pay this fine" });
        }

        // Logic for partial payment
        const remainingBalance = fine.totalAmountWithInterest - fine.paidAmount;
        const amountToPay = paymentAmount || remainingBalance;

        if (amountToPay <= 0) return res.status(400).json({ message: "Invalid payment amount" });
        if (amountToPay > remainingBalance) return res.status(400).json({ message: `Payment exceeds remaining balance of ${remainingBalance} RWF` });

        // Debit wallet
        const wallet = await walletService.debitWallet(driverId.toString(), amountToPay, "fine_payment", {
            description: `Fine payment for ID: ${fine.fineId}. Part of ${fine.totalAmountWithInterest} RWF total.`,
        });

        fine.paidAmount += amountToPay;
        if (fine.paidAmount >= fine.totalAmountWithInterest) {
            fine.status = "paid";
        } else {
            fine.status = "partially_paid";
        }
        await fine.save();

        const user = await User.findById(driverId);
        if (user) {
            const smsText = `MOTA: Fine ${fine.fineId} payment of ${amountToPay} RWF successful. Remaining: ${fine.totalAmountWithInterest - fine.paidAmount} RWF.`;
            await sendSMS(user.phone, smsText, "fine_payment");

            if (user.email) {
                const html = `<h2>MOTA Fine Payment</h2>
                              <p>A payment of ${amountToPay} RWF was made against your fine (ID: ${fine.fineId}).</p>
                              <ul>
                                <li>Total with Interest: ${fine.totalAmountWithInterest} RWF</li>
                                <li>Paid Today: ${amountToPay} RWF</li>
                                <li>Total Paid: ${fine.paidAmount} RWF</li>
                                <li><b>Remaining Balance: ${fine.totalAmountWithInterest - fine.paidAmount} RWF</b></li>
                              </ul>
                              <p>Your current wallet balance is: ${wallet.balance} RWF.</p>`;
                await sendEmail(user.email, "MOTA Fine Payment Receipt", smsText, html);
            }
        }

        res.status(200).json({
            message: fine.status === "paid" ? "Fine fully paid" : "Partial payment successful",
            amountToPay,
            remaining: fine.totalAmountWithInterest - fine.paidAmount,
            fine
        });
    } catch (error) {
        if (error.message.includes("Insufficient wallet balance")) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    createProfile,
    getDashboard,
    getProfile,
    updateProfile,
    getRideHistory,
    payFine: payFineApi,
};
