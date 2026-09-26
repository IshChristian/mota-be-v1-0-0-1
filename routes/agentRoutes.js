const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const Referral = require("../models/Referral");
const SupportCase = require("../models/SupportCase");
const DriverKyc = require("../models/DriverKyc");
const auditService = require("../services/auditService");
const { protect: authMiddleware } = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const { sendSMS } = require("../services/smsService");
const walletService = require("../services/walletService");
const agentController = require("../controllers/agentController");

/**
 * @swagger
 * tags:
 *   name: Agent
 *   description: Agent driver onboarding and management
 */

// All agent routes require authentication and agent/admin role
router.use(authMiddleware, roleMiddleware("agent", "admin"));

/**
 * @swagger
 * /api/agent/register-driver:
 *   post:
 *     summary: Register a new driver (agent onboarding)
 *     tags: [Agent]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *               - lastName
 *               - phone
 *               - nationalId
 *             properties:
 *               firstName:
 *                 type: string
 *                 example: Pierre
 *               lastName:
 *                 type: string
 *                 example: Nshimiyimana
 *               phone:
 *                 type: string
 *                 example: "+250788654321"
 *               nationalId:
 *                 type: string
 *                 example: "1199780056781234"
 *               plateNumber:
 *                 type: string
 *                 example: "RAD 789 C"
 *               cooperativeName:
 *                 type: string
 *                 example: "Remera Moto Coop"
 *               nid:
 *                 type: string
 *                 example: "1199780056781234"
 *               insuranceAttachment:
 *                 type: string
 *                 example: "https://storage.example.com/insurance.pdf"
 *               permitAttachment:
 *                 type: string
 *                 example: "https://storage.example.com/permit.pdf"
 *               permitId:
 *                 type: string
 *                 example: "DL-2024-005678"
 *     responses:
 *       201:
 *         description: Driver registered successfully
 *       400:
 *         description: Missing fields or user already exists
 *       500:
 *         description: Server error
 */
router.post("/register-driver", async (req, res) => {
    try {
        const agentId = req.user.id;
        const {
            firstName, lastName, phone, nationalId,
            plateNumber, cooperativeName, nid,
            insuranceAttachment, permitAttachment, permitId,
        } = req.body;

        if (!firstName || !lastName || !phone || !nationalId) {
            return res.status(400).json({ message: "firstName, lastName, phone, and nationalId are required" });
        }

        // Check existing user
        const existingUser = await User.findOne({
            $or: [{ phone }, { nationalId }],
        });
        if (existingUser) {
            return res.status(400).json({ message: "User with this phone or national ID already exists" });
        }

        // Create user
        const referralCode = `MOTA-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const newUser = new User({
            firstName,
            lastName,
            phone,
            nationalId,
            role: "driver",
            referralCode,
            isVerified: false,
            registrationStatus: "pending",
        });

        await newUser.save();

        // Create referral record (agent → driver)
        await Referral.create({
            referrerId: agentId,
            referredUserId: newUser._id,
            reward: 3000,
            status: "pending",
        });

        // An agent can start registration; KYC and activation require the normal review flow.

        // Send welcome SMS
        await sendSMS(
            phone,
            `Welcome to MOTA, ${firstName}! An agent submitted your registration. Verify your phone and await review before driving.`,
            "registration"
        );

        res.status(201).json({
            message: "Driver registered successfully",
            driver: {
                id: newUser._id,
                firstName: newUser.firstName,
                lastName: newUser.lastName,
                phone: newUser.phone,
                referralCode: newUser.referralCode,
            },
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

/**
 * @swagger
 * /api/agent/drivers:
 *   get:
 *     summary: Get drivers registered by this agent
 *     tags: [Agent]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: List of drivers registered by this agent
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get("/drivers", async (req, res) => {
    try {
        const agentId = req.user.id;
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;

        const referrals = await Referral.find({ referrerId: agentId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate("referredUserId", "firstName lastName phone isVerified isActive kycLevel registrationStatus registrationPaid createdAt");

        const total = await Referral.countDocuments({ referrerId: agentId });

        const ids = referrals.map((ref) => ref.referredUserId?._id).filter(Boolean);
        const kyc = await DriverKyc.find({ userId: { $in: ids } }).select("userId status remarks").lean();
        const kycByDriver = new Map(kyc.map((row) => [String(row.userId), { status: row.status, remarks: row.remarks }]));
        const drivers = referrals.filter((ref) => ref.referredUserId).map((ref) => ({
            ...ref.referredUserId?.toObject(),
            kyc: kycByDriver.get(String(ref.referredUserId._id)) || null,
            registeredAt: ref.createdAt,
            referralStatus: ref.status,
            reward: ref.reward,
        }));

        res.status(200).json({
            drivers,
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
});

router.get("/update-requests", async (req, res) => {
    try {
        const data = await SupportCase.find({ createdBy: req.user.id, $or: [{ subject: /^Agent assistance:/ }, { subject: "Agent requested driver account update" }] })
            .select("driverId subject description status resolution createdAt updatedAt")
            .sort({ createdAt: -1 }).limit(100).lean();
        res.json({ data });
    } catch (error) { res.status(500).json({ message: "Unable to load requests" }); }
});

router.post("/drivers/:id/update-request", async (req, res) => {
    try {
        const driver = await User.findOne({ _id: req.params.id, role: "driver" });
        if (!driver) return res.status(404).json({ message: "Driver not found" });
        const referral = await Referral.findOne({ referrerId: req.user.id, referredUserId: driver._id });
        if (!referral && req.user.role !== "admin") return res.status(403).json({ message: "Only the registering agent can request this update" });
        const description = String(req.body.description || "").trim();
        if (description.length < 10 || description.length > 2000) return res.status(400).json({ message: "Describe the requested change in 10 to 2000 characters" });
        const kinds = { profile_update: "Profile update", kyc_help: "KYC assistance", fee_help: "Fee assistance", account_access: "Account access" };
        const kind = req.body.kind || "profile_update";
        if (!Object.hasOwn(kinds, kind)) return res.status(400).json({ message: "Invalid assistance type" });
        const request = await SupportCase.create({ driverId: driver._id, createdBy: req.user.id, category: kind === "fee_help" ? "payment" : "other", subject: `Agent assistance: ${kinds[kind]}`, description, status: "open" });
        await auditService.log({ actorId: req.user.id, actorRole: req.user.role, action: "support_case_created", targetType: "SupportCase", targetId: request._id, ipAddress: req.ip, metadata: { driverId: String(driver._id), source: "agent_update_request" } });
        res.status(201).json({ message: "Update request sent for administrator review", data: { id: request._id, status: request.status } });
    } catch (error) { res.status(400).json({ message: error.message }); }
});

/**
 * @swagger
 * /api/agent/stats:
 *   get:
 *     summary: Get agent statistics
 *     tags: [Agent]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Agent registration and referral stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalRegistered:
 *                   type: number
 *                 completedReferrals:
 *                   type: number
 *                 pendingReferrals:
 *                   type: number
 *                 totalRewards:
 *                   type: number
 *       500:
 *         description: Server error
 */
router.get("/stats", async (req, res) => {
    try {
        const agentId = req.user.id;

        const totalRegistered = await Referral.countDocuments({ referrerId: agentId });
        const completedReferrals = await Referral.countDocuments({ referrerId: agentId, status: "successful" });
        const pendingReferrals = await Referral.countDocuments({ referrerId: agentId, status: "pending" });

        const rewardAgg = await Referral.aggregate([
            { $match: { referrerId: agentId, status: "successful" } },
            { $group: { _id: null, total: { $sum: "$reward" } } },
        ]);

        res.status(200).json({
            totalRegistered,
            completedReferrals,
            pendingReferrals,
            totalRewards: rewardAgg[0]?.total || 0,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

/**
 * @swagger
 * /api/agent/cash-in:
 *   post:
 *     summary: Agent records physical cash deposit into driver wallet
 *     tags: [Agent]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - driverPhone
 *               - amount
 *             properties:
 *               driverPhone:
 *                 type: string
 *                 example: "+250788123456"
 *               amount:
 *                 type: number
 *                 example: 5000
 *     responses:
 *       200:
 *         description: Driver wallet credited successfully
 *       400:
 *         description: Missing fields or invalid amount
 *       404:
 *         description: Driver not found
 *       500:
 *         description: Server error
 */
router.post("/cash-in", async (req, res) => {
    try {
        const agentId = req.user.id;
        const { driverPhone, amount } = req.body;

        if (!driverPhone || !amount || amount <= 0) {
            return res.status(400).json({ message: "driverPhone and a positive amount are required" });
        }

        // Find driver by phone (normalize)
        let formattedPhone = driverPhone;
        if (formattedPhone.startsWith("0")) formattedPhone = "+250" + formattedPhone.substring(1);
        else if (formattedPhone.startsWith("250")) formattedPhone = "+" + formattedPhone;

        const driver = await User.findOne({
            $or: [{ phone: formattedPhone }, { phone: driverPhone }],
            role: "driver",
        });

        if (!driver) {
            return res.status(404).json({ message: "Driver not found with this phone number" });
        }

        const wallet = await walletService.agentCashIn(agentId, driver._id.toString(), amount);

        res.status(200).json({
            message: "Cash-in recorded successfully",
            driverId: driver._id,
            driverName: `${driver.firstName} ${driver.lastName}`,
            amount,
            newBalance: wallet.balance,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

/**
 * @swagger
 * /api/agent/pay-fine:
 *   post:
 *     summary: Agent pays a driver's fine using agent wallet balance
 *     tags: [Agent]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - driverId
 *               - fineId
 *               - amount
 *             properties:
 *               driverId:
 *                 type: string
 *               fineId:
 *                 type: string
 *               amount:
 *                 type: number
 *     responses:
 *       200:
 *         description: Fine payment processed
 */
router.post("/pay-fine", agentController.payFineForDriver);

module.exports = router;
