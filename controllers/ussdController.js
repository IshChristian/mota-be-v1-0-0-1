const mongoose = require("mongoose");
const User = require("../models/User");
const Ride = require("../models/Ride");
const Fine = require("../models/Fine");
const walletService = require("../services/walletService");
const { getTierInfo } = require("../services/tierService");
const { getStreakInfo, DAILY_TARGET } = require("../services/streakService");
const paymentService = require("../services/paymentService");
const Transaction = require("../models/Transaction");

const normalizePhone = (phone) => {
    if (!phone) return "";
    if (phone.startsWith("0")) return "+250" + phone.substring(1);
    if (phone.startsWith("250")) return "+" + phone;
    return phone;
};

const handleUssd = async (req, res) => {
    let { sessionId, serviceCode, phoneNumber, text } = req.body;
    const formattedPhone = normalizePhone(phoneNumber || "");
    res.set("Content-Type", "text/plain");

    try {
        if (!text || text === "") {
            return res.status(200).send("CON Welcome to MOTA\n\n1 MOTA Moto Rider (Driver)\n2 MOTA Ride (Passenger/Client)");
        }

        const parts = text.split("*");
        const userType = parts[0];

        if (userType !== "1" && userType !== "2") {
            return res.status(200).send("END Invalid selection");
        }

        // ==============================================================
        // PASSENGER / CLIENT FLOW
        // ==============================================================
        if (userType === "2") {
            if (parts.length === 1) {
                return res.status(200).send("CON MOTA Client Services\n\n1 Pay Ride (by Driver Phone)\n2 Pay Ride (by Merchant Code)\n3 Request Transaction Info\n4 Check Pilot Debt\n0 Exit");
            }
            const pMenu = parts[1];

            if (pMenu === "1" || pMenu === "2") {
                const isPhone = pMenu === "1";
                if (parts.length === 2) {
                    return res.status(200).send("CON Enter Your MoMo Phone Number:");
                }
                if (parts.length === 3) {
                    return res.status(200).send(`CON Enter Pilot ${isPhone ? "Phone Number" : "Merchant Code"}:`);
                }
                if (parts.length === 4) {
                    return res.status(200).send("CON Enter amount (RWF):");
                }

                const passengerPhone = normalizePhone(parts[2]);
                const targetId = parts[3];
                const amount = parseInt(parts[4]);

                if (isNaN(amount) || amount <= 0) {
                    return res.status(200).send("END Invalid amount.");
                }

                // Verify the pilot (driver) exists
                const targetDriver = isPhone
                    ? await User.findOne({ phone: normalizePhone(targetId), role: "driver" })
                    : await User.findOne({ _id: targetId, role: "driver" }).catch(() => null);

                if (!targetDriver) {
                    return res.status(200).send(`END Error: Pilot with ${isPhone ? 'phone' : 'code'} ${targetId} is not registered.`);
                }

                // Initiate Paypack Momo push to provided passenger phone
                const result = await paymentService.requestCashIn(
                    passengerPhone,
                    amount,
                    process.env.PAYPACK_ENV || "development"
                );

                if (result.success) {
                    await Transaction.create({
                        driverId: targetDriver._id,
                        amount,
                        type: "ride_payment",
                        status: "pending",
                        paypackRef: result.data?.ref,
                        description: `USSD Client Ride Payment to ${isPhone ? 'phone' : 'code'} ${targetId} from ${passengerPhone}`,
                    });
                    return res.status(200).send(`END Payment Initiated!\nPlease wait for the MoMo prompt on ${passengerPhone} to authorize ${amount} RWF.\nDial *182*7*1# if it doesn't appear.`);
                } else {
                    return res.status(200).send("END Payment gateway error. Could not initiate payment.");
                }
            }
            if (pMenu === "3") {
                if (parts.length === 2) {
                    return res.status(200).send("CON Enter Phone Number to check history:");
                }
                const checkPhone = normalizePhone(parts[2]);
                const txs = await Transaction.find({ description: { $regex: checkPhone } }).sort({ createdAt: -1 }).limit(3);
                if (txs.length === 0) return res.status(200).send(`END No recent transactions found for ${checkPhone}.`);
                const list = txs.map(t => `${t.type}: ${t.amount} RWF (${t.status})`).join("\n");
                return res.status(200).send(`END Recent Transactions for ${checkPhone}:\n${list}`);
            }
            if (pMenu === "4") {
                if (parts.length === 2) {
                    return res.status(200).send("CON Enter Pilot Phone or Code:");
                }
                const targetId = parts[2];
                const pilot = await User.findOne({
                    $or: [{ phone: normalizePhone(targetId) }, { _id: mongoose.Types.ObjectId.isValid(targetId) ? targetId : null }],
                    role: "driver"
                });

                if (!pilot) return res.status(200).send(`END Error: Pilot with ${targetId} not found.`);

                const fines = await Fine.find({ driverId: pilot._id, status: { $in: ["approved", "partially_paid"] } });
                const totalDebt = fines.reduce((sum, f) => sum + (f.totalAmountWithInterest - f.paidAmount), 0);

                return res.status(200).send(`END Status for ${pilot.firstName}:\nOutstanding Debt: ${totalDebt} RWF.\n${totalDebt > 0 ? 'Please clear balance at any MOTA agent.' : 'Clear record. Good to go!'}`);
            }
            if (pMenu === "0") {
                return res.status(200).send("END Thank you for using MOTA.");
            }
            return res.status(200).send("END Invalid option.");
        }

        // ==============================================================
        // DRIVER FLOW
        // ==============================================================
        if (userType === "1") {
            const user = await User.findOne({
                $or: [{ phone: formattedPhone }, { phone: phoneNumber }],
            });

            if (!user || user.role !== "driver") {
                return res.status(200).send("END Your number is not registered as a MOTA Driver. Please sign up first.");
            }

            const driverId = user._id;

            if (parts.length === 1) {
                return res.status(200).send(
                    "CON MOTA Driver Menu\n\n1 Dashboard\n2 Cash In\n3 Wallet\n4 Fines\n5 Referral\n0 Exit"
                );
            }

            const menu = parts[1];

            // 1: Dashboard
            if (menu === "1") {
                const streakInfo = await getStreakInfo(driverId);
                const tierInfo = await getTierInfo(driverId);
                const wallet = await walletService.getOrCreateWallet(driverId);

                // Calculate loan balance
                const fines = await Fine.find({ driverId, status: { $in: ["approved", "partially_paid"] } });
                const totalDebt = fines.reduce((sum, f) => sum + (f.totalAmountWithInterest - f.paidAmount), 0);

                return res.status(200).send(
                    `END Dashboard\nRides Today: ${streakInfo.todayRideCount}/${DAILY_TARGET}\nStreak: ${streakInfo.currentStreak} days\nTier: ${tierInfo.tier.toUpperCase()}\nWallet: ${wallet.balance} RWF\nLoans: ${totalDebt} RWF`
                );
            }

            // 2: Cash In (Logged Ride)
            if (menu === "2") {
                if (parts.length === 2) {
                    return res.status(200).send("CON Enter Cash In amount (RWF):");
                }
                if (parts.length === 3) {
                    const fare = parseInt(parts[2]);
                    if (isNaN(fare) || fare <= 0) {
                        return res.status(200).send("END Invalid amount.");
                    }
                    return res.status(200).send("CON Enter Phone to Charge (Passenger's or your own):");
                }

                const fare = parseInt(parts[2]);
                const phoneToCharge = parts[3];

                if (!phoneToCharge || isNaN(fare) || fare <= 0) {
                    return res.status(200).send("END Invalid input.");
                }

                const { commission, driverEarning } = await walletService.calculateCommission(fare);

                const ride = await Ride.create({
                    driverId,
                    passengerPhone: phoneToCharge,
                    fare,
                    commissionRate: walletService.COMMISSION_RATE,
                    commissionAmount: commission,
                    driverEarning,
                    paymentMethod: "momo",
                    paymentStatus: "pending",
                });

                const result = await paymentService.requestCashIn(
                    phoneToCharge,
                    fare,
                    process.env.PAYPACK_ENV || "development"
                );

                if (result.success) {
                    await Transaction.create({
                        driverId,
                        rideId: ride._id,
                        amount: fare,
                        type: "cash_in",
                        status: "pending",
                        paypackRef: result.data?.ref,
                        description: `USSD Cash In (Ride). Charging: ${phoneToCharge}`,
                    });
                    ride.paypackRef = result.data?.ref;
                    await ride.save();

                    return res.status(200).send(
                        `END Cash In Initiated!\nPlease authorize payment of ${fare} RWF on phone: ${phoneToCharge}.`
                    );
                } else {
                    return res.status(200).send("END Gateway error. Could not initiate MoMo payment.");
                }
            }

            // 3: Wallet
            if (menu === "3") {
                if (parts.length === 2) {
                    const wallet = await walletService.getOrCreateWallet(driverId);
                    return res.status(200).send(`CON Wallet: ${wallet.balance} RWF\n\n1 Instant Cash-Out\n0 Back`);
                }
                if (parts.length === 3 && parts[2] === "1") {
                    return res.status(200).send("CON Enter amount to withdraw (RWF):");
                }
                if (parts.length === 4 && parts[2] === "1") {
                    const amount = parseInt(parts[3]);
                    if (isNaN(amount) || amount <= 0) {
                        return res.status(200).send("END Invalid amount");
                    }

                    // Process cash-out with fee deduction via new service
                    let cashOutResult;
                    try {
                        cashOutResult = await walletService.processCashOut(driverId.toString(), amount);
                    } catch (err) {
                        const wallet = await walletService.getOrCreateWallet(driverId);
                        return res.status(200).send(`END Error: ${err.message}`);
                    }

                    const result = await paymentService.requestCashOut(
                        user.phone,
                        amount,
                        process.env.PAYPACK_ENV || "development"
                    );

                    if (result.success) {
                        return res.status(200).send(`END Success! ${amount} RWF sent to MoMo account (${user.phone}). Fee: ${cashOutResult.fee} RWF.`);
                    } else {
                        // Refund wrapper requires amount (the exact amount deducted base)
                        await walletService.creditWallet(driverId.toString(), cashOutResult.totalDeduction, "cash_out_refund", { description: "Refund for failed cash-out (includes fee)" });
                        return res.status(200).send("END Gateway error. Your balance is restored.");
                    }
                }
                return res.status(200).send("END Invalid wallet option");
            }

            // 4: Fines
            if (menu === "4") {
                if (parts.length === 2) {
                    return res.status(200).send("CON Fines\n\n1 View Fines & Debt\n2 Request Fine Payment\n3 Pay Fine (using Wallet)");
                }

                // 4-1: View Fines
                if (parts.length === 3 && parts[2] === "1") {
                    const fines = await Fine.find({ driverId, status: { $in: ["approved", "partially_paid"] } }).limit(3);
                    if (fines.length === 0) return res.status(200).send("END You have no approved fines or active debts.");
                    const list = fines.map((f) =>
                        `ID:${f.fineId}\nDebt:${f.totalAmountWithInterest} - Paid:${f.paidAmount}\nStatus:${f.status}`
                    ).join("\n---\n");
                    return res.status(200).send(`CON Active Fines:\n${list}\n\n0 Back`);
                }

                // 4-2: Request payment (Admin Review)
                if (parts.length === 3 && parts[2] === "2") {
                    return res.status(200).send("CON Enter Fine ID:\n(Admin will review)");
                }
                if (parts.length === 4 && parts[2] === "2") {
                    const fineId = parts[3];
                    await Fine.create({ driverId, fineId, amount: 0, status: "pending" });
                    return res.status(200).send("END Request received.\nAdmin will review.");
                }

                // 4-3: Pay Fine using Wallet
                if (parts.length === 3 && parts[2] === "3") {
                    return res.status(200).send("CON Enter Fine ID to pay:");
                }
                if (parts.length === 4 && parts[2] === "3") {
                    return res.status(200).send("CON Enter amount to pay (RWF):");
                }
                if (parts.length === 5 && parts[2] === "3") {
                    const fineIdInput = parts[3];
                    const amountToPay = parseInt(parts[4]);

                    const fine = await Fine.findOne({ driverId, fineId: fineIdInput, status: { $in: ["approved", "partially_paid"] } });
                    if (!fine) return res.status(200).send("END Fine record not found or already paid.");

                    const remaining = fine.totalAmountWithInterest - fine.paidAmount;
                    if (amountToPay > remaining) return res.status(200).send(`END Error: Amount exceeds balance of ${remaining} RWF.`);

                    try {
                        await walletService.debitWallet(driverId.toString(), amountToPay, "fine_payment", {
                            description: `USSD partial payment for Fine ${fine.fineId}`
                        });

                        fine.paidAmount += amountToPay;
                        fine.status = (fine.paidAmount >= fine.totalAmountWithInterest) ? "paid" : "partially_paid";
                        await fine.save();

                        return res.status(200).send(`END Success! Paid ${amountToPay} RWF.\nRemaining Balance: ${fine.totalAmountWithInterest - fine.paidAmount} RWF.`);
                    } catch (err) {
                        return res.status(200).send(`END Payment failed: ${err.message}`);
                    }
                }

                return res.status(200).send("END Invalid fine option");
            }

            // 5: Referral
            if (menu === "5") {
                return res.status(200).send(`END Referral Code:\n${user.referralCode || "N/A"}\nShare to earn rewards.`);
            }

            if (menu === "0") {
                return res.status(200).send("END Thank you for using MOTA!");
            }

            return res.status(200).send("END Invalid option");
        }

    } catch (error) {
        console.error("USSD Error:", error);
        return res.status(200).send("END System error. Please try again later.");
    }
};

module.exports = { handleUssd };
