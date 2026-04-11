const fineRequestService = require("../services/fineRequestService");

/**
 * POST /api/fine-requests
 * Driver submits a fine request for admin approval
 */
const createFineRequest = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { fineId, amount, reason, attachments } = req.body;

        if (!fineId) {
            return res.status(400).json({ message: "fineId is required" });
        }
        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "A valid fine amount is required" });
        }

        const fineRequest = await fineRequestService.createFineRequest(driverId, {
            fineId,
            amount,
            reason,
            attachments,
        });

        res.status(201).json({
            message: "Fine request submitted successfully. Waiting for admin approval.",
            fineRequest,
        });
    } catch (error) {
        if (error.message.includes("already have an active")) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/fine-requests/my
 * Get authenticated driver's fine requests
 */
const getMyFineRequests = async (req, res) => {
    try {
        const driverId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await fineRequestService.getMyFineRequests(driverId, page, limit);

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/fine-requests/:id
 * Get a specific fine request
 */
const getFineRequestById = async (req, res) => {
    try {
        const fineRequest = await fineRequestService.getFineRequestById(req.params.id);

        if (!fineRequest) {
            return res.status(404).json({ message: "Fine request not found" });
        }

        res.status(200).json({ fineRequest });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/fine-requests (admin)
 * Get all fine requests with filters
 */
const getAllFineRequests = async (req, res) => {
    try {
        const { status, driverId, page = 1, limit = 20 } = req.query;

        const result = await fineRequestService.getFineRequests(
            { status, driverId },
            parseInt(page),
            parseInt(limit)
        );

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * PUT /api/fine-requests/:id/approve (admin)
 */
const approveFineRequest = async (req, res) => {
    try {
        const adminId = req.user.id;
        const { amount, notes } = req.body;

        const result = await fineRequestService.approveFineRequest(
            req.params.id,
            adminId,
            { amount, notes }
        );

        res.status(200).json({
            message: "Fine request approved successfully",
            fineRequest: result.fineRequest,
            fine: result.fine,
        });
    } catch (error) {
        if (error.message.includes("Cannot approve") || error.message.includes("not found")) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * PUT /api/fine-requests/:id/reject (admin)
 */
const rejectFineRequest = async (req, res) => {
    try {
        const adminId = req.user.id;
        const { reason } = req.body;

        const fineRequest = await fineRequestService.rejectFineRequest(
            req.params.id,
            adminId,
            reason
        );

        res.status(200).json({
            message: "Fine request rejected",
            fineRequest,
        });
    } catch (error) {
        if (error.message.includes("Cannot reject") || error.message.includes("not found")) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * PUT /api/fine-requests/:id/review (admin)
 * Mark as under review
 */
const markUnderReview = async (req, res) => {
    try {
        const adminId = req.user.id;

        const fineRequest = await fineRequestService.markUnderReview(req.params.id, adminId);

        res.status(200).json({
            message: "Fine request marked as under review",
            fineRequest,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    createFineRequest,
    getMyFineRequests,
    getFineRequestById,
    getAllFineRequests,
    approveFineRequest,
    rejectFineRequest,
    markUnderReview,
};
