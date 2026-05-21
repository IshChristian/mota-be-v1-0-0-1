const Transfer = require("../models/Transfer");
const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const walletService = require("./walletService");
const { sendSMS } = require("./smsService");
const configService = require("./configService");
const crypto = require("crypto");
const QRCode = require("qrcode");

/**
 * Generate a unique transfer reference
 */
const generateReference = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();
    return `TRF-${timestamp}-${random}`;
};

/**
 * Find user by phone number
 */
const findUserByPhone = async (phone) => {
    // Normalize phone number
    let normalized = phone.replace(/\s+/g, "").replace(/-/g, "");
    if (normalized.startsWith("0")) {
        normalized = "+250" + normalized.substring(1);
    }
    if (!normalized.startsWith("+")) {
        normalized = "+250" + normalized;
    }

    // Try exact match first, then variants
    let user = await User.findOne({ phone: normalized });
    if (!user) {
        user = await User.findOne({ phone: phone });
    }
    if (!user) {
        // Try without +
        user = await User.findOne({ phone: normalized.replace("+", "") });
    }

    return user;
};

/**
 * Send money to another user (Direct / JSON method)
 * @param {string} senderId - Sender's user ID
 * @param {string} receiverPhone - Receiver's phone number
 * @param {number} amount - Amount to transfer
 * @param {string} description - Optional description
 * @returns {Object} Transfer result
 */
const sendMoney = async (senderId, receiverPhone, amount, description = "") => {
    if (!receiverPhone) throw new Error("Receiver phone number is required");
    if (!amount || amount <= 0) throw new Error("Amount must be greater than 0");

    // Find receiver
    const receiver = await findUserByPhone(receiverPhone);
    if (!receiver) {
        throw new Error(`No user found with phone number: ${receiverPhone}`);
    }

    // Can't send to self
    if (receiver._id.toString() === senderId.toString()) {
        throw new Error("Cannot transfer money to yourself");
    }

    // Get transfer fee from settings (default 1%)
    const feePercentage = await configService.getConfig("transfer_fee_percentage", 1);
    const fee = Math.round(amount * (feePercentage / 100));
    const totalDeduction = amount + fee;

    // Check sender balance
    const senderWallet = await walletService.getOrCreateWallet(senderId);
    if (senderWallet.balance < totalDeduction) {
        throw new Error(
            `Insufficient balance. Need ${totalDeduction} RWF (amount: ${amount} + fee: ${fee}). Available: ${senderWallet.balance} RWF`
        );
    }

    const reference = generateReference();

    // Debit sender
    senderWallet.balance -= totalDeduction;
    await senderWallet.save();

    // Credit receiver
    const receiverWallet = await walletService.getOrCreateWallet(receiver._id);
    receiverWallet.balance += amount;
    await receiverWallet.save();

    // Create transfer record
    const transfer = await Transfer.create({
        senderId,
        receiverId: receiver._id,
        amount,
        feeAmount: fee,
        method: "direct",
        status: "successful",
        reference,
        description: description || `Transfer to ${receiver.firstName} ${receiver.lastName}`,
    });

    // Create transaction records
    await Transaction.create({
        driverId: senderId,
        amount: -totalDeduction,
        feeAmount: fee,
        type: "cash_out",
        status: "successful",
        reference,
        description: `P2P Transfer to ${receiver.phone}. Amount: ${amount} RWF. Fee: ${fee} RWF.`,
    });

    await Transaction.create({
        driverId: receiver._id,
        amount: amount,
        type: "cash_in",
        status: "successful",
        reference,
        description: `P2P Transfer received from ${(await User.findById(senderId)).phone}. Amount: ${amount} RWF.`,
    });

    // Fee transaction
    if (fee > 0) {
        await Transaction.create({
            driverId: senderId,
            amount: fee,
            type: "transaction_fee",
            status: "successful",
            reference,
            description: `Transfer fee (${feePercentage}%). Fee: ${fee} RWF.`,
        });
    }

    // SMS notifications
    const sender = await User.findById(senderId);
    if (sender) {
        await sendSMS(
            sender.phone,
            `MOTA: You sent ${amount} RWF to ${receiver.firstName} ${receiver.lastName} (${receiver.phone}). Fee: ${fee} RWF. Ref: ${reference}. Balance: ${senderWallet.balance} RWF`,
            "transfer_sent"
        );
    }

    await sendSMS(
        receiver.phone,
        `MOTA: You received ${amount} RWF from ${sender?.firstName || "Unknown"} ${sender?.lastName || ""}. Ref: ${reference}. Balance: ${receiverWallet.balance} RWF`,
        "transfer_received"
    );

    return {
        transfer,
        senderBalance: senderWallet.balance,
        receiverBalance: receiverWallet.balance,
        fee,
        totalDeducted: totalDeduction,
    };
};

/**
 * Send money via QR code (same logic but method = qr_code)
 */
const sendMoneyViaQR = async (senderId, receiverPhone, amount, description = "") => {
    if (!receiverPhone) throw new Error("Receiver phone number is required");
    if (!amount || amount <= 0) throw new Error("Amount must be greater than 0");

    const receiver = await findUserByPhone(receiverPhone);
    if (!receiver) {
        throw new Error(`No user found with phone number: ${receiverPhone}`);
    }

    if (receiver._id.toString() === senderId.toString()) {
        throw new Error("Cannot transfer money to yourself");
    }

    const feePercentage = await configService.getConfig("transfer_fee_percentage", 1);
    const fee = Math.round(amount * (feePercentage / 100));
    const totalDeduction = amount + fee;

    const senderWallet = await walletService.getOrCreateWallet(senderId);
    if (senderWallet.balance < totalDeduction) {
        throw new Error(
            `Insufficient balance. Need ${totalDeduction} RWF. Available: ${senderWallet.balance} RWF`
        );
    }

    const reference = generateReference();

    // Debit sender
    senderWallet.balance -= totalDeduction;
    await senderWallet.save();

    // Credit receiver
    const receiverWallet = await walletService.getOrCreateWallet(receiver._id);
    receiverWallet.balance += amount;
    await receiverWallet.save();

    // Create transfer record
    const transfer = await Transfer.create({
        senderId,
        receiverId: receiver._id,
        amount,
        feeAmount: fee,
        method: "qr_code",
        status: "successful",
        reference,
        description: description || `QR Transfer to ${receiver.firstName} ${receiver.lastName}`,
    });

    // Transaction records
    await Transaction.create({
        driverId: senderId,
        amount: -totalDeduction,
        feeAmount: fee,
        type: "cash_out",
        status: "successful",
        reference,
        description: `QR Transfer to ${receiver.phone}. Amount: ${amount} RWF. Fee: ${fee} RWF.`,
    });

    await Transaction.create({
        driverId: receiver._id,
        amount: amount,
        type: "cash_in",
        status: "successful",
        reference,
        description: `QR Transfer received. Amount: ${amount} RWF.`,
    });

    if (fee > 0) {
        await Transaction.create({
            driverId: senderId,
            amount: fee,
            type: "transaction_fee",
            status: "successful",
            reference,
            description: `QR Transfer fee (${feePercentage}%). Fee: ${fee} RWF.`,
        });
    }

    // SMS
    const sender = await User.findById(senderId);
    if (sender) {
        await sendSMS(
            sender.phone,
            `MOTA: QR Transfer of ${amount} RWF sent to ${receiver.firstName}. Fee: ${fee} RWF. Ref: ${reference}. Balance: ${senderWallet.balance} RWF`,
            "transfer_sent"
        );
    }

    await sendSMS(
        receiver.phone,
        `MOTA: You received ${amount} RWF via QR. Ref: ${reference}. Balance: ${receiverWallet.balance} RWF`,
        "transfer_received"
    );

    return {
        transfer,
        senderBalance: senderWallet.balance,
        fee,
        totalDeducted: totalDeduction,
    };
};

/**
 * Generate QR code for receiving payments
 * Contains user's phone number and optional amount
 */
const generateReceiveQR = async (userId, amount = null) => {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");

    const qrPayload = {
        type: "mota_payment",
        phone: user.phone,
        userId: user._id.toString(),
        name: `${user.firstName} ${user.lastName}`,
        ...(amount && { amount }),
        timestamp: Date.now(),
    };

    const qrString = JSON.stringify(qrPayload);

    // Generate QR as data URL
    const qrDataUrl = await QRCode.toDataURL(qrString, {
        width: 400,
        margin: 2,
        color: {
            dark: "#000000",
            light: "#FFFFFF",
        },
    });

    return {
        qr_data: qrString,
        qr_image: qrDataUrl,
        payload: qrPayload,
    };
};

/**
 * Get transfer history for a user
 */
const getTransferHistory = async (userId, page = 1, limit = 20) => {
    const skip = (page - 1) * limit;

    const transfers = await Transfer.find({
        $or: [{ senderId: userId }, { receiverId: userId }],
    })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("senderId", "firstName lastName phone")
        .populate("receiverId", "firstName lastName phone");

    const total = await Transfer.countDocuments({
        $or: [{ senderId: userId }, { receiverId: userId }],
    });

    return {
        transfers: transfers.map((t) => ({
            ...t.toObject(),
            direction: t.senderId._id.toString() === userId.toString() ? "sent" : "received",
        })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

module.exports = {
    sendMoney,
    sendMoneyViaQR,
    generateReceiveQR,
    getTransferHistory,
    findUserByPhone,
    generateReference,
};
