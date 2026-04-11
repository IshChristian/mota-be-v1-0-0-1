const transferService = require("../services/transferService");

/**
 * POST /api/transfer/send
 * Send money to another user (JSON: phone + amount)
 */
const sendMoney = async (req, res) => {
    try {
        const senderId = req.user.id;
        const { phone, amount, description } = req.body;

        if (!phone) {
            return res.status(400).json({ message: "Receiver phone number is required" });
        }
        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "Valid amount is required (greater than 0)" });
        }

        const result = await transferService.sendMoney(senderId, phone, amount, description);

        res.status(200).json({
            message: `Successfully sent ${amount} RWF`,
            reference: result.transfer.reference,
            amount,
            fee: result.fee,
            totalDeducted: result.totalDeducted,
            senderBalance: result.senderBalance,
            transfer: result.transfer,
        });
    } catch (error) {
        if (error.message.includes("Insufficient") || error.message.includes("No user found") || error.message.includes("Cannot transfer")) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/transfer/send-qr
 * Send money via QR code scan
 * Body receives the decoded QR payload (phone, amount)
 */
const sendMoneyQR = async (req, res) => {
    try {
        const senderId = req.user.id;
        const { phone, amount, description } = req.body;

        if (!phone) {
            return res.status(400).json({ message: "Receiver phone (from QR scan) is required" });
        }
        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "Valid amount is required" });
        }

        const result = await transferService.sendMoneyViaQR(senderId, phone, amount, description);

        res.status(200).json({
            message: `QR payment of ${amount} RWF successful`,
            reference: result.transfer.reference,
            amount,
            fee: result.fee,
            totalDeducted: result.totalDeducted,
            senderBalance: result.senderBalance,
            transfer: result.transfer,
        });
    } catch (error) {
        if (error.message.includes("Insufficient") || error.message.includes("No user found") || error.message.includes("Cannot transfer")) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/transfer/qr-code
 * Generate a QR code for receiving payments
 */
const generateQRCode = async (req, res) => {
    try {
        const userId = req.user.id;
        const amount = req.query.amount ? Number(req.query.amount) : null;

        const result = await transferService.generateReceiveQR(userId, amount);

        res.status(200).json({
            message: "QR code generated successfully",
            qr_image: result.qr_image,
            qr_data: result.qr_data,
            payload: result.payload,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/transfer/history
 * Get transfer history for authenticated user
 */
const getTransferHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await transferService.getTransferHistory(userId, page, limit);

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    sendMoney,
    sendMoneyQR,
    generateQRCode,
    getTransferHistory,
};
