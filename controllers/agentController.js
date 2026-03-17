const User = require("../models/User");
const Fine = require("../models/Fine");
const walletService = require("../services/walletService");
const { sendSMS } = require("../services/smsService");
const { sendEmail } = require("../services/notificationService");

/**
 * Agent pays fine on behalf of driver
 * POST /api/agent/pay-fine
 */
const payFineForDriver = async (req, res) => {
    try {
        const agentId = req.user.id;
        const { driverId, fineId, amount } = req.body;

        if (!driverId || !fineId || !amount || amount <= 0) {
            return res.status(400).json({ message: "driverId, fineId, and amount are required" });
        }

        const fine = await Fine.findById(fineId);
        if (!fine) return res.status(404).json({ message: "Fine not found" });
        if (fine.status === "paid") return res.status(400).json({ message: "Fine is already fully paid" });
        if (fine.driverId.toString() !== driverId.toString()) {
            return res.status(400).json({ message: "Fine does not belong to this driver" });
        }

        const remainingBalance = fine.totalAmountWithInterest - fine.paidAmount;
        if (amount > remainingBalance) {
            return res.status(400).json({ message: `Payment exceeds remaining balance of ${remainingBalance} RWF` });
        }

        // Debit agent's wallet
        const agentWallet = await walletService.debitWallet(agentId.toString(), amount, "agent_pay_fine", {
            description: `Payment for driver fine (ID: ${fine.fineId}, Driver ID: ${driverId})`,
        });

        // Update Fine
        fine.paidAmount += amount;
        if (fine.paidAmount >= fine.totalAmountWithInterest) {
            fine.status = "paid";
        } else {
            fine.status = "partially_paid";
        }
        await fine.save();

        // Notify Driver
        const driver = await User.findById(driverId);
        if (driver) {
            const smsText = `MOTA: Agent ${req.user.firstName} paid ${amount} RWF for your fine ${fine.fineId}. Remaining: ${fine.totalAmountWithInterest - fine.paidAmount} RWF.`;
            await sendSMS(driver.phone, smsText, "payment_received");

            if (driver.email) {
                const html = `<h2>Fine Payment by Agent</h2>
                              <p>Agent ${req.user.firstName} ${req.user.lastName} has made a payment of ${amount} RWF against your fine (ID: ${fine.fineId}).</p>
                              <ul>
                                <li>Total with Interest: ${fine.totalAmountWithInterest} RWF</li>
                                <li>Paid by Agent: ${amount} RWF</li>
                                <li><b>Your Remaining Balance: ${fine.totalAmountWithInterest - fine.paidAmount} RWF</b></li>
                              </ul>`;
                await sendEmail(driver.email, "MOTA: Fine Payment Received", smsText, html);
            }
        }

        res.status(200).json({
            message: "Fine payment processed successfully",
            amountPaid: amount,
            remaining: fine.totalAmountWithInterest - fine.paidAmount,
            agentBalance: agentWallet.balance
        });
    } catch (error) {
        if (error.message.includes("Insufficient wallet balance")) {
            return res.status(400).json({ message: "Agent has insufficient balance to cover this payment" });
        }
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    payFineForDriver,
};
