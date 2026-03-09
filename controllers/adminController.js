const mongoose = require("mongoose");
const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const Ride = require("../models/Ride");
const Tier = require("../models/Tier");
const Streak = require("../models/Streak");
const Referral = require("../models/Referral");
const SmsLog = require("../models/SmsLog");
const Fine = require("../models/Fine");
const { sendSMS } = require("../services/smsService");

/**
 * Get all drivers with profiles
 * GET /api/admin/drivers
 */
const getDrivers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search || "";

    let query = { role: "driver" };
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { nationalId: { $regex: search, $options: "i" } },
      ];
    }

    const drivers = await User.find(query)
      .select("-password -otpToken")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments(query);

    // Enrich with profile data
    const enrichedDrivers = await Promise.all(
      drivers.map(async (driver) => {
        const profile = await DriverProfile.findOne({ driverId: driver._id });
        const tier = await Tier.findOne({ driverId: driver._id });
        return {
          ...driver.toObject(),
          profile: profile || null,
          tier: tier ? tier.tier : "bronze",
        };
      })
    );

    res.status(200).json({
      drivers: enrichedDrivers,
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
 * Get driver detail by ID
 * GET /api/admin/drivers/:id
 */
const getDriverById = async (req, res) => {
  try {
    const { id } = req.params;

    const driver = await User.findById(id).select("-password -otpToken");
    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    const profile = await DriverProfile.findOne({ driverId: id });
    const tier = await Tier.findOne({ driverId: id });
    const streak = await Streak.findOne({ driverId: id });

    // Get ride stats
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const totalRides = await Ride.countDocuments({ driverId: id });
    const monthlyRides = await Ride.countDocuments({
      driverId: id,
      createdAt: { $gte: startOfMonth },
    });

    const referrals = await Referral.countDocuments({ referrerId: id, status: "completed" });

    res.status(200).json({
      driver,
      profile,
      tier: tier || { tier: "bronze", multiplier: 1.0 },
      streak: streak || { currentStreak: 0, longestStreak: 0 },
      stats: {
        totalRides,
        monthlyRides,
        referrals,
        wallet: profile ? profile.wallet : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * Get platform analytics
 * GET /api/admin/analytics
 */
const getAnalytics = async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // User stats
    const totalDrivers = await User.countDocuments({ role: "driver" });
    const totalAgents = await User.countDocuments({ role: "agent" });
    const verifiedDrivers = await User.countDocuments({ role: "driver", isVerified: true });
    const activeDrivers = await User.countDocuments({ role: "driver", isActive: true });

    // Ride stats
    const totalRides = await Ride.countDocuments();
    const ridesToday = await Ride.countDocuments({ createdAt: { $gte: startOfDay } });
    const ridesThisMonth = await Ride.countDocuments({ createdAt: { $gte: startOfMonth } });

    // Revenue stats
    const revenueToday = await Ride.aggregate([
      { $match: { createdAt: { $gte: startOfDay } } },
      { $group: { _id: null, total: { $sum: "$fare" } } },
    ]);

    const revenueThisMonth = await Ride.aggregate([
      { $match: { createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$fare" } } },
    ]);

    // Tier distribution
    const tierDistribution = await Tier.aggregate([
      { $group: { _id: "$tier", count: { $sum: 1 } } },
    ]);

    // Payment method distribution
    const paymentDistribution = await Ride.aggregate([
      { $group: { _id: "$paymentMethod", count: { $sum: 1 } } },
    ]);

    // Referral stats
    const totalReferrals = await Referral.countDocuments();
    const completedReferrals = await Referral.countDocuments({ status: "completed" });

    // SMS stats
    const totalSMS = await SmsLog.countDocuments();
    const smsSent = await SmsLog.countDocuments({ status: "sent" });
    const smsFailed = await SmsLog.countDocuments({ status: "failed" });

    res.status(200).json({
      users: {
        totalDrivers,
        totalAgents,
        verifiedDrivers,
        activeDrivers,
      },
      rides: {
        totalRides,
        ridesToday,
        ridesThisMonth,
      },
      revenue: {
        today: revenueToday[0]?.total || 0,
        thisMonth: revenueThisMonth[0]?.total || 0,
      },
      tiers: tierDistribution.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        { bronze: 0, silver: 0, gold: 0, platinum: 0 }
      ),
      payments: paymentDistribution.reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        { cash: 0, momo: 0 }
      ),
      referrals: {
        total: totalReferrals,
        completed: completedReferrals,
      },
      sms: {
        total: totalSMS,
        sent: smsSent,
        failed: smsFailed,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * Get all users (admin view)
 * GET /api/admin/users
 */
const getAllUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const role = req.query.role;

    let query = {};
    if (role) {
      query.role = role;
    }

    const users = await User.find(query)
      .select("-password -otpToken")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments(query);

    res.status(200).json({
      users,
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
 * Activate / Deactivate user
 * PUT /api/admin/users/:id/status
 */
const updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive (boolean) is required" });
    }

    const user = await User.findByIdAndUpdate(
      id,
      { isActive },
      { new: true }
    ).select("-password -otpToken");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: `User ${isActive ? "activated" : "deactivated"} successfully`,
      user,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * Verify user (admin)
 * PUT /api/admin/users/:id/verify
 */
const verifyUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndUpdate(
      id,
      { isVerified: true },
      { new: true }
    ).select("-password -otpToken");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ message: "User verified successfully", user });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * Update KYC level (admin)
 * PUT /api/admin/users/:id/kyc
 */
const updateKycLevel = async (req, res) => {
  try {
    const { id } = req.params;
    const { kycLevel } = req.body;

    if (!["basic", "full"].includes(kycLevel)) {
      return res.status(400).json({ message: "kycLevel must be 'basic' or 'full'" });
    }

    const user = await User.findByIdAndUpdate(
      id,
      { kycLevel },
      { new: true }
    ).select("-password -otpToken");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ message: "KYC level updated successfully", user });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * Delete user (admin)
 * DELETE /api/admin/users/:id
 */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndDelete(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Clean up related data
    await DriverProfile.deleteOne({ driverId: id });
    await Tier.deleteOne({ driverId: id });
    await Streak.deleteOne({ driverId: id });
    await Ride.deleteMany({ driverId: id });
    await Referral.deleteMany({ $or: [{ referrerId: id }, { referredUserId: id }] });

    res.status(200).json({ message: "User and all related data deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * Get all agents
 * GET /api/admin/agents
 */
const getAgents = async (req, res) => {
  try {
    const agents = await User.find({ role: "agent" })
      .select("-password -otpToken")
      .sort({ createdAt: -1 });

    const enrichedAgents = await Promise.all(
      agents.map(async (agent) => {
        const registeredDrivers = await Referral.countDocuments({ referrerId: agent._id });
        return {
          ...agent.toObject(),
          registeredDrivers,
        };
      })
    );

    res.status(200).json(enrichedAgents);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * Approve or reject a fine payment request
 * POST /api/admin/fines/approve
 */
const approveFine = async (req, res) => {
  try {
    const { id, status, amount } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
    }

    const fine = await Fine.findById(id).populate("driverId", "phone firstName");
    if (!fine) {
      return res.status(404).json({ message: "Fine request not found" });
    }

    fine.status = status;
    fine.reviewedAt = Date.now();
    fine.reviewedBy = req.user.id;

    if (status === "approved" && amount !== undefined) {
      fine.amount = amount;
    }

    await fine.save();

    // Send SMS notification
    if (fine.driverId && fine.driverId.phone) {
      const message = status === "approved"
        ? `Hello ${fine.driverId.firstName}, your fine payment request (ID: ${fine.fineId}) has been approved. Amount: ${fine.amount} RWF.`
        : `Hello ${fine.driverId.firstName}, your fine payment request (ID: ${fine.fineId}) has been rejected.`;

      await sendSMS(fine.driverId.phone, message, "system_alert");
    }

    res.status(200).json({ message: `Fine request ${status} successfully`, fine });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

module.exports = {
  getDrivers,
  getDriverById,
  getAnalytics,
  getAllUsers,
  updateUserStatus,
  verifyUser,
  updateKycLevel,
  deleteUser,
  getAgents,
  approveFine,
};
