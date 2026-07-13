const loanService = require("../services/loanService");

// ─── Driver Endpoints ────────────────────────────────────────────────────────

/**
 * POST /api/loans/request
 * Driver requests a fine loan
 */
const requestLoan = async (req, res) => {
    try {
        const mongoose = require("mongoose");
        const driverId = mongoose.Types.ObjectId.createFromHexString(req.user.id);
        
        if (!req.body.fineId) {
            return res.status(400).json({ message: "fineId is required" });
        }
        
        const fineId = mongoose.Types.ObjectId.createFromHexString(req.body.fineId);

        const loan = await loanService.requestLoan(driverId, fineId);
        res.status(201).json({
            message: "Loan request submitted. Pending admin approval.",
            data: loan,
        });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

/**
 * GET /api/loans/my-loans
 * Driver views their loans
 */
const getMyLoans = async (req, res) => {
    try {
        const loans = await loanService.getDriverLoans(req.user.id);
        res.status(200).json({ data: loans });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/loans/repay
 * Driver manually repays a loan from wallet
 */
const repayLoan = async (req, res) => {
    try {
        const { loanId, amount } = req.body;
        if (!loanId || !amount || amount <= 0) {
            return res.status(400).json({ message: "loanId and a positive amount are required" });
        }
        const result = await loanService.repayLoan(loanId, amount, req.user.id);
        res.status(200).json({
            message: result.loan.loanStatus === "successful" ? "Loan fully repaid!" : "Loan repayment successful",
            data: result,
        });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// ─── Admin Endpoints ─────────────────────────────────────────────────────────

/**
 * GET /api/loans/admin/all
 * Admin lists all loans
 */
const getAllLoans = async (req, res) => {
    try {
        const { status, page, limit } = req.query;
        const result = await loanService.getAllLoans(
            status || null,
            parseInt(page) || 1,
            parseInt(limit) || 20
        );
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/loans/admin/approve
 * Admin approves or rejects a loan
 */
const approveLoan = async (req, res) => {
    try {
        const { loanId, action } = req.body;
        if (!loanId || !action) {
            return res.status(400).json({ message: "loanId and action (approve/reject) are required" });
        }

        let loan;
        if (action === "approve") {
            loan = await loanService.approveLoan(loanId, req.user.id);
        } else if (action === "reject") {
            loan = await loanService.rejectLoan(loanId, req.user.id);
        } else {
            return res.status(400).json({ message: "action must be 'approve' or 'reject'" });
        }

        res.status(200).json({
            message: `Loan ${action}d successfully`,
            data: loan,
        });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

module.exports = {
    requestLoan,
    getMyLoans,
    repayLoan,
    getAllLoans,
    approveLoan,
};
