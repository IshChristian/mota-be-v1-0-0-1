const Transaction = require("../models/Transaction");
const Ride = require("../models/Ride");
const Wallet = require("../models/Wallet");
const User = require("../models/User");
const walletService = require("../services/walletService");
const paymentService = require("../services/paymentService");
const { sendSMS } = require("../services/smsService");
const { sendEmail } = require("../services/notificationService");

/**
 * POST /api/payment/request
 * Driver requests payment from passenger via Paypack
 */
const requestPayment = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { passengerPhone, amount, rideId } = req.body;

        if (!passengerPhone || !amount || amount <= 0) {
            return res.status(400).json({ message: "passengerPhone and amount are required" });
        }

        const result = await paymentService.requestCashIn(
            passengerPhone,
            amount,
            process.env.PAYPACK_ENV || "development"
        );

        if (!result.success) {
            return res.status(502).json({ message: "Payment gateway error", error: result.error });
        }

        // Record pending transaction
        const { commission, driverEarning } = walletService.calculateCommission(amount);
        await Transaction.create({
            driverId,
            rideId: rideId || null,
            amount,
            type: "cash_in",
            status: "pending",
            paypackRef: result.data?.ref,
            description: `Cash In via MoMo. Fare: ${amount} RWF, Driver earns: ${driverEarning} RWF`,
        });

        // Update ride paypack ref if rideId provided
        if (rideId) {
            await Ride.findByIdAndUpdate(rideId, {
                paypackRef: result.data?.ref,
                paymentStatus: "pending",
            });
        }

        res.status(200).json({
            message: "Payment request sent to passenger.",
            ref: result.data?.ref,
            amount,
            driverEarning,
            commission,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * POST /api/payment/webhook
 * Paypack sends payment confirmation
 */
const handleWebhook = async (req, res) => {
    try {
        const event = req.body;

        if (!event || !event.ref) {
            return res.status(400).json({ message: "Invalid webhook payload" });
        }

        const { ref, status, amount, kind } = event;

        // Find pending transaction by paypackRef
        const tx = await Transaction.findOne({ paypackRef: ref, status: "pending" });

        if (!tx) {
            // Still acknowledge
            return res.status(200).json({ message: "Webhook received" });
        }

        if (status === "successful" || status === "completed") {
            tx.status = "completed";
            await tx.save();

            // Unified Cash In handler — ride-based, pure wallet deposit or USSD ride payment
            if (tx.driverId) {
                const user = await User.findById(tx.driverId);
                const isRidePayment = tx.type === "ride_payment" || (tx.type === "cash_in" && tx.rideId);

                if (isRidePayment) {
                    // Ride-related payment (triggered by driver log or USSD passenger pay)
                    // Calculate commission (logic inside creditRidePayment or manually here)
                    const { commission, driverEarning } = await walletService.calculateCommission(amount);

                    // Credit the rider's wallet
                    await walletService.creditWallet(
                        tx.driverId.toString(),
                        driverEarning,
                        "ride_payment",
                        { paypackRef: ref, description: tx.description || `Ride payment received: ${amount} RWF` }
                    );

                    // If it was a logged ride, update ride status
                    if (tx.rideId) {
                        await Ride.findByIdAndUpdate(tx.rideId, { paymentStatus: "completed" });
                    }

                    const wallet = await Wallet.findOne({ driverId: tx.driverId });
                    const newBalance = wallet ? wallet.balance : 0;

                    // 1. Send SMS to rider
                    if (user) {
                        await sendSMS(
                            user.phone,
                            `MOTA Payment\nYou received ${amount} RWF from passenger.\nEarnings: ${driverEarning} RWF\nBalance: ${newBalance} RWF`,
                            "payment_received"
                        );

                        // 2. Send Email to rider
                        if (user.email) {
                            const riderHtml = `<h3>Payment Received</h3>
                                <p>Hello ${user.firstName},</p>
                                <p>You have received a ride payment via MOTA.</p>
                                <ul>
                                    <li><b>Base Amount:</b> ${amount} RWF</li>
                                    <li><b>Your Earnings (after comm.):</b> ${driverEarning} RWF</li>
                                    <li><b>Updated Wallet Balance:</b> ${newBalance} RWF</li>
                                </ul>`;
                            await sendEmail(user.email, "MOTA: Payment Received", "", riderHtml);
                        }
                    }

                    // 3. Send Email to Admin
                    const adminEmail = process.env.ADMIN_EMAIL || "admin@mota.rw";
                    const adminHtml = `<h3>New Ride Payment Confirmation</h3>
                        <p>A ride payment has been successfully processed.</p>
                        <ul>
                            <li><b>Driver:</b> ${user ? `${user.firstName} ${user.lastName} (${user.phone})` : tx.driverId}</li>
                            <li><b>Amount Paid:</b> ${amount} RWF</li>
                            <li><b>Commission:</b> ${commission} RWF</li>
                            <li><b>Paid via:</b> Paypack (Ref: ${ref})</li>
                        </ul>`;
                    await sendEmail(adminEmail, "MOTA Admin: Ride Payment Alert", "", adminHtml);

                    // Update performance stats
                    const { updateStreak } = require("../services/streakService");
                    const { updateTier } = require("../services/tierService");
                    await updateStreak(tx.driverId.toString());
                    await updateTier(tx.driverId.toString());

                } else if (tx.type === "cash_in") {
                    // Pure wallet deposit → credit full amount
                    await walletService.creditWallet(
                        tx.driverId.toString(),
                        Math.abs(amount),
                        "cash_in",
                        { paypackRef: ref, description: `Wallet Cash-in via Paypack. ${amount} RWF` }
                    );
                    const wallet = await Wallet.findOne({ driverId: tx.driverId });
                    if (user) {
                        await sendSMS(
                            user.phone,
                            `MOTA Wallet\nCash-in confirmed.\nAmount: ${amount} RWF\nNew Balance: ${wallet?.balance || 0} RWF`,
                            "cash_in"
                        );
                    }
                }
            }
        } else if (status === "failed") {
            tx.status = "failed";
            await tx.save();

            if (tx.rideId) {
                await Ride.findByIdAndUpdate(tx.rideId, { paymentStatus: "failed" });
            }
        }

        res.status(200).json({ message: "Webhook processed" });
    } catch (error) {
        console.error("Webhook error:", error.message);
        res.status(500).json({ message: "Webhook error", error: error.message });
    }
};

module.exports = {
    requestPayment,
    handleWebhook,
};
