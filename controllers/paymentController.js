const Transaction = require("../models/Transaction");
const Ride = require("../models/Ride");
const Wallet = require("../models/Wallet");
const User = require("../models/User");
const walletService = require("../services/walletService");
const paymentService = require("../services/paymentService");
const loanService = require("../services/loanService");
const { sendSMS } = require("../services/smsService");
const { sendEmail } = require("../services/notificationService");
const EventEmitter = require("events");

// ── In-process SSE bus ─────────────────────────────────────────────────────
// Emits  "tx:<paypackRef>"  with the updated transaction document
// when the Paypack webhook confirms a payment status change.
const txBus = new EventEmitter();
txBus.setMaxListeners(200); // allow many concurrent listeners

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
        const payload = req.body.data || req.body;
        
        if (!payload || !payload.ref) {
            return res.status(400).json({ message: "Invalid webhook payload structure" });
        }

        const { ref, status, amount, kind } = payload;

        // Find pending transaction by paypackRef
        const tx = await Transaction.findOne({ paypackRef: ref, status: "pending" });

        if (!tx) {
            // It might be a registration payment (which doesn't create a Transaction record yet)
            const user = await User.findOne({ registrationPaypackRef: ref });
            if (user && !user.registrationPaid) {
                if (status === "successful" || status === "completed") {
                    user.registrationPaid = true;
                    user.registrationStatus = "pending";
                    if (user.role === "agent") {
                        user.kycLevel = "full";
                    }
                    await user.save();
                    // ⚡ Instantly notify any SSE listeners watching this ref
                    txBus.emit(`tx:${ref}`);
                }
            }
            
            // Still acknowledge
            return res.status(200).json({ message: "Webhook received" });
        }

        if (status === "successful" || status === "completed") {
            tx.status = "completed";
            await tx.save();

            // ⚡ Instantly notify any SSE listeners watching this ref
            txBus.emit(`tx:${ref}`);

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

                    // ── Update streak / tier / algorithm ────────────────────
                    // IMPORTANT: ride.paymentStatus was just set to "completed"
                    // above, so countDocuments({ paymentStatus: "completed" })
                    // in streakService will now include this ride correctly.
                    // Rides that are still "pending" are NOT counted toward the
                    // 20-ride daily target.
                    try {
                        const { updateStreak } = require("../services/streakService");
                        const { updateTier }   = require("../services/tierService");
                        const algorithmService = require("../services/algorithmService");

                        await updateStreak(tx.driverId.toString());
                        await updateTier(tx.driverId.toString());

                        try {
                            await algorithmService.processRide(tx.driverId.toString());
                        } catch (algoErr) {
                            console.error("Algorithm engine error (non-blocking):", algoErr.message);
                        }
                    } catch (statErr) {
                        console.error("Streak/tier update error (non-blocking):", statErr.message);
                    }

                    // ── Auto-deduct loan repayment from ride earnings ─────────
                    try {
                        const loanDeducted = await loanService.autoDeductFromRide(tx.driverId.toString(), driverEarning);
                        if (loanDeducted > 0 && user) {
                            const updatedWallet = await Wallet.findOne({ driverId: tx.driverId });
                            await sendSMS(
                                user.phone,
                                `MOTA Loan\nAuto-repayment of ${loanDeducted} RWF deducted from ride earnings.\nWallet Balance: ${updatedWallet?.balance || 0} RWF`,
                                "fine_loan_repayment"
                            );
                        }
                    } catch (loanErr) {
                        console.error("Loan auto-deduction error:", loanErr.message);
                    }

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

            // ⚡ Instantly notify any SSE listeners watching this ref
            txBus.emit(`tx:${ref}`);

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

// ──────────────────────────────────────────────────────────────────

/**
 * GET /api/payment/status/:ref
 * One-shot polling: return current transaction status for a paypackRef.
 */
const getTransactionStatus = async (req, res) => {
    try {
        const { ref } = req.params;
        if (!ref) return res.status(400).json({ message: "Paypack ref is required." });

        const tx = await Transaction.findOne({ paypackRef: ref })
            .select("status amount type description paypackRef rideId createdAt")
            .populate("rideId", "paymentStatus fare passengerPhone");

        if (!tx) {
            return res.status(404).json({ message: "Transaction not found for this ref." });
        }

        // Only return the transaction if it belongs to the requesting driver
        if (tx.driverId && req.user && tx.driverId.toString() !== req.user.id) {
            return res.status(403).json({ message: "Access denied." });
        }

        return res.status(200).json({
            ref,
            status: tx.status,                      // pending | completed | failed
            amount: tx.amount,
            type: tx.type,
            description: tx.description,
            ride: tx.rideId
                ? {
                      rideId: tx.rideId._id,
                      paymentStatus: tx.rideId.paymentStatus,
                      fare: tx.rideId.fare,
                      passengerPhone: tx.rideId.passengerPhone,
                  }
                : null,
            createdAt: tx.createdAt,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/payment/status-stream/:ref
 * Server-Sent Events: streams real-time transaction status updates.
 *
 * Flow:
 *  1. Opens SSE connection, sends current status immediately.
 *  2. Listens on txBus for "tx:<ref>" event (emitted by handleWebhook).
 *  3. Also polls every 3 seconds as a safety net (in case webhook fires
 *     before the SSE client connected).
 *  4. Closes the stream when status is "completed" or "failed".
 *
 * Client usage (JavaScript):
 *   const es = new EventSource('/api/payment/status-stream/pp_ref_xyz?token=<jwt>');
 *   es.onmessage = (e) => console.log(JSON.parse(e.data));
 */
const POLL_INTERVAL_MS = 1000;  // check DB/Paypack every 1 sec as safety net
const SSE_TIMEOUT_MS  = 5 * 60 * 1000; // auto-close after 5 minutes

const streamTransactionStatus = async (req, res) => {
    const { ref } = req.params;
    if (!ref) {
        return res.status(400).json({ message: "Paypack ref is required." });
    }

    // ── SSE headers ───────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
    res.flushHeaders();

    let closed = false;

    const send = (payload) => {
        if (!closed) {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
    };

    const close = (reason) => {
        if (!closed) {
            closed = true;
            send({ ref, status: "stream_closed", reason });
            res.end();
        }
    };

    // Helper: fetch tx and push to client
    const pushStatus = async () => {
        try {
            let tx = await Transaction.findOne({ paypackRef: ref })
                .select("status amount type description rideId createdAt driverId")
                .populate("rideId", "paymentStatus fare passengerPhone");

            if (!tx) {
                send({ ref, status: "not_found", message: "Transaction not found." });
                close("transaction_not_found");
                return;
            }

            // Ownership check
            if (req.user && tx.driverId && tx.driverId.toString() !== req.user.id) {
                send({ ref, status: "forbidden" });
                close("access_denied");
                return;
            }

            // ── Real-time Paypack Check (Active Polling) ──────────────
            // If local DB still says pending, double-check directly with Paypack
            if (tx.status === "pending") {
                const ppStatusResult = await paymentService.getTransactionStatus(ref);
                if (ppStatusResult.success && ppStatusResult.data) {
                    const realStatus = ppStatusResult.data.status; // e.g. "successful", "failed", "pending"
                    if (realStatus === "successful" || realStatus === "failed") {
                        // Forward this to our webhook handler logic directly to ensure all wallet/streak logic runs
                        // Since we just need to pass the event object it expects:
                        const fakeEvent = {
                            ref: ppStatusResult.data.ref,
                            status: realStatus,
                            amount: ppStatusResult.data.amount,
                            kind: ppStatusResult.data.kind
                        };
                        
                        // Fake a req/res for handleWebhook to process it inline
                        const fakeReq = { body: fakeEvent };
                        const fakeRes = { status: () => ({ json: () => {} }) };
                        await handleWebhook(fakeReq, fakeRes);
                        
                        // Re-fetch the transaction from DB after processing
                        tx = await Transaction.findOne({ paypackRef: ref })
                            .select("status amount type description rideId createdAt driverId")
                            .populate("rideId", "paymentStatus fare passengerPhone");
                    }
                }
            }

            send({
                ref,
                status: tx.status,           // pending | completed | failed
                amount: tx.amount,
                type: tx.type,
                description: tx.description,
                ride: tx.rideId
                    ? {
                          rideId: tx.rideId._id,
                          paymentStatus: tx.rideId.paymentStatus,
                          fare: tx.rideId.fare,
                          passengerPhone: tx.rideId.passengerPhone,
                      }
                    : null,
                timestamp: new Date().toISOString(),
            });

            // Terminal state — close stream
            if (tx.status === "completed" || tx.status === "failed") {
                close(`payment_${tx.status}`);
            }
        } catch (err) {
            console.error("SSE pushStatus error:", err.message);
        }
    };

    // ── 1. Send current status immediately ──────────────────────────
    await pushStatus();
    if (closed) return;

    // ── 2. Subscribe to webhook push events ────────────────────────
    const eventName = `tx:${ref}`;
    const onTxUpdate = () => {
        pushStatus(); // re-query DB when webhook fires
    };
    txBus.on(eventName, onTxUpdate);

    // ── 3. Safety-net poll (every 3 s) ────────────────────────────
    const pollTimer = setInterval(pushStatus, POLL_INTERVAL_MS);

    // ── 4. Auto-close after timeout ──────────────────────────────
    const timeoutTimer = setTimeout(() => close("timeout"), SSE_TIMEOUT_MS);

    // ── Cleanup on client disconnect ────────────────────────────
    req.on("close", () => {
        closed = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        txBus.off(eventName, onTxUpdate);
    });
};

module.exports = {
    requestPayment,
    handleWebhook,
    getTransactionStatus,
    streamTransactionStatus,
    txBus, // exported so handleWebhook can emit from anywhere if refactored
};
