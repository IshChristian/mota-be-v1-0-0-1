const FineRequest = require("../models/FineRequest");
const Fine = require("../models/Fine");
const User = require("../models/User");
const { sendSMS } = require("./smsService");
const { sendEmail } = require("./notificationService");
const configService = require("./configService");
const { recordFinePaid } = require("./algorithmService");

/**
 * Create a fine request (driver submits to admin for approval)
 */
const createFineRequest = async (driverId, data) => {
    const { fineId, amount, reason, attachments } = data;

    if (!fineId) throw new Error("fineId is required");
    if (!amount || amount <= 0) throw new Error("Amount must be greater than 0");

    // Check for existing active fine request for this fineId
    const existing = await FineRequest.findOne({
        driverId,
        fineId,
        status: { $in: ["pending", "under_review"] },
    });

    if (existing) {
        throw new Error("You already have an active fine request for this fine ID. Please wait for approval.");
    }

    const fineRequest = await FineRequest.create({
        driverId,
        fineId,
        amount,
        reason: reason || "",
        attachments: attachments || [],
        status: "pending",
    });

    // Notify admin(s)
    const admins = await User.find({ role: "admin", isActive: true });
    for (const admin of admins) {
        if (admin.phone) {
            await sendSMS(
                admin.phone,
                `MOTA Admin: New fine request from driver. Fine ID: ${fineId}. Amount: ${amount} RWF. Review required.`,
                "admin_fine_request"
            );
        }
    }

    // Notify driver
    const driver = await User.findById(driverId);
    if (driver && driver.phone) {
        await sendSMS(
            driver.phone,
            `MOTA: Your fine request (ID: ${fineId}) for ${amount} RWF has been submitted. Waiting for admin approval.`,
            "fine_request_submitted"
        );
    }

    return fineRequest;
};

/**
 * Get all fine requests (admin view, with filters)
 */
const getFineRequests = async (filters = {}, page = 1, limit = 20) => {
    const skip = (page - 1) * limit;
    const query = {};

    if (filters.status) query.status = filters.status;
    if (filters.driverId) query.driverId = filters.driverId;

    const requests = await FineRequest.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("driverId", "firstName lastName phone nationalId")
        .populate("reviewedBy", "firstName lastName");

    const total = await FineRequest.countDocuments(query);

    return {
        requests,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Get a single fine request by ID
 */
const getFineRequestById = async (requestId) => {
    return await FineRequest.findById(requestId)
        .populate("driverId", "firstName lastName phone nationalId")
        .populate("reviewedBy", "firstName lastName")
        .populate("resultingFineId");
};

/**
 * Get fine requests for a specific driver
 */
const getMyFineRequests = async (driverId, page = 1, limit = 20) => {
    const skip = (page - 1) * limit;

    const requests = await FineRequest.find({ driverId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

    const total = await FineRequest.countDocuments({ driverId });

    return {
        requests,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Approve a fine request (admin action)
 * Creates the actual Fine record and notifies the driver
 */
const approveFineRequest = async (requestId, adminId, overrides = {}) => {
    const fineRequest = await FineRequest.findById(requestId);
    if (!fineRequest) throw new Error("Fine request not found");

    if (fineRequest.status !== "pending" && fineRequest.status !== "under_review") {
        throw new Error(`Cannot approve a fine request with status: ${fineRequest.status}`);
    }

    const finalAmount = overrides.amount || fineRequest.amount;
    const interestRate = await configService.getConfig("fine_interest_rate", 5);
    const totalWithInterest = Math.round(finalAmount * (1 + interestRate / 100));

    // Create the actual Fine record
    const fine = await Fine.create({
        driverId: fineRequest.driverId,
        fineId: fineRequest.fineId,
        amount: finalAmount,
        status: "approved",
        interestRate: interestRate / 100,
        totalAmountWithInterest: totalWithInterest,
        reviewedBy: adminId,
        reviewedAt: new Date(),
    });

    // Update fine request
    fineRequest.status = "approved";
    fineRequest.reviewedBy = adminId;
    fineRequest.reviewedAt = new Date();
    fineRequest.reviewNotes = overrides.notes || "";
    fineRequest.resultingFineId = fine._id;
    await fineRequest.save();

    // Notify driver
    const driver = await User.findById(fineRequest.driverId);
    if (driver) {
        const smsMsg = `MOTA: Your fine request (${fineRequest.fineId}) has been APPROVED. Amount: ${finalAmount} RWF. Total with interest: ${totalWithInterest} RWF. Please proceed with payment.`;
        if (driver.phone) await sendSMS(driver.phone, smsMsg, "fine_approved");

        if (driver.email) {
            const html = `<h2>MOTA Fine Approved</h2>
                <p>Your fine request has been approved by an administrator.</p>
                <ul>
                    <li><b>Fine ID:</b> ${fineRequest.fineId}</li>
                    <li><b>Amount:</b> ${finalAmount} RWF</li>
                    <li><b>Interest:</b> ${interestRate}%</li>
                    <li><b>Total Due:</b> ${totalWithInterest} RWF</li>
                </ul>
                <p>Please log in to your MOTA account to make payment.</p>`;
            await sendEmail(driver.email, "MOTA Fine Approved", smsMsg, html);
        }
    }

    return { fineRequest, fine };
};

/**
 * Reject a fine request (admin action)
 */
const rejectFineRequest = async (requestId, adminId, reason = "") => {
    const fineRequest = await FineRequest.findById(requestId);
    if (!fineRequest) throw new Error("Fine request not found");

    if (fineRequest.status !== "pending" && fineRequest.status !== "under_review") {
        throw new Error(`Cannot reject a fine request with status: ${fineRequest.status}`);
    }

    fineRequest.status = "rejected";
    fineRequest.reviewedBy = adminId;
    fineRequest.reviewedAt = new Date();
    fineRequest.reviewNotes = reason;
    await fineRequest.save();

    // Notify driver
    const driver = await User.findById(fineRequest.driverId);
    if (driver && driver.phone) {
        await sendSMS(
            driver.phone,
            `MOTA: Your fine request (${fineRequest.fineId}) has been REJECTED.${reason ? ` Reason: ${reason}` : ""} Contact support if you have questions.`,
            "fine_rejected"
        );
    }

    return fineRequest;
};

/**
 * Mark a fine request as under review (admin starts reviewing)
 */
const markUnderReview = async (requestId, adminId) => {
    const fineRequest = await FineRequest.findById(requestId);
    if (!fineRequest) throw new Error("Fine request not found");

    if (fineRequest.status !== "pending") {
        throw new Error("Only pending requests can be set to under review");
    }

    fineRequest.status = "under_review";
    fineRequest.reviewedBy = adminId;
    await fineRequest.save();

    return fineRequest;
};

module.exports = {
    createFineRequest,
    getFineRequests,
    getFineRequestById,
    getMyFineRequests,
    approveFineRequest,
    rejectFineRequest,
    markUnderReview,
};
