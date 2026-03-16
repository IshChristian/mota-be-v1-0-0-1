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
                return res.status(200).send("CON MOTA Client Services\n\n1 Pay Ride (by Driver Phone)\n2 Pay Ride (by Code)\n3 Request Transaction Info\n0 Exit");
            }
            const pMenu = parts[1];

            if (pMenu === "1" || pMenu === "2") {
                const isPhone = pMenu === "1";
                if (parts.length === 2) {
                    return res.status(200).send(`CON Enter Driver ${isPhone ? "Phone Number" : "Code"}:`);
                }
                if (parts.length === 3) {
                    return res.status(200).send("CON Enter amount to pay (RWF):");
                }
                const targetId = parts[2];
                const amount = parseInt(parts[3]);

                if (isNaN(amount) || amount <= 0) {
                    return res.status(200).send("END Invalid amount.");
                }

                // Initiate Paypack Momo push to client
                const result = await paymentService.requestCashIn(
                    formattedPhone,
                    amount,
                    process.env.PAYPACK_ENV || "development"
                );

                if (result.success) {
                    await Transaction.create({
                        amount,
                        type: "ride_payment",
                        status: "pending",
                        paypackRef: result.data?.ref,
                        description: `USSD Client Ride Payment to ${isPhone ? 'phone' : 'code'} ${targetId} from ${formattedPhone}`,
                    });
                    return res.status(200).send(`END Payment Initiated!\nPlease authorize payment of ${amount} RWF on your phone. Driver will be credited immediately.`);
                } else {
                    return res.status(200).send("END Payment gateway error. Could not initiate payment.");
                }
            }
            if (pMenu === "3") {
                const txs = await Transaction.find({ description: { $regex: formattedPhone } }).sort({ createdAt: -1 }).limit(3);
                if (txs.length === 0) return res.status(200).send("END No recent transactions found for your number.");
                const list = txs.map(t => `${t.type}: ${t.amount} RWF (${t.status})`).join("\n");
                return res.status(200).send(`END Your Recent Transactions:\n${list}`);
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
                return res.status(200).send(
                    `END Dashboard\nRides Today: ${streakInfo.todayRideCount}/${DAILY_TARGET}\nStreak: ${streakInfo.currentStreak} days\nTier: ${tierInfo.tier.toUpperCase()}\nWallet: ${wallet.balance} RWF`
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
                    const wallet = await walletService.getOrCreateWallet(driverId);

                    // We must check if they can afford amount + transaction fee (1%) if implemented in service.
                    // But walletService checks this automatically now if we updated it.
                    try {
                        await walletService.debitWallet(driverId.toString(), amount, "cash_out", { description: "USSD Instant Cash-Out" });
                    } catch (err) {
                        return res.status(200).send(`END Error: ${err.message}. Current balance: ${wallet.balance} RWF`);
                    }

                    const result = await paymentService.requestCashOut(
                        user.phone,
                        amount,
                        process.env.PAYPACK_ENV || "development"
                    );

                    if (result.success) {
                        await Transaction.create({
                            driverId,
                            amount,
                            type: "cash_out",
                            status: "completed",
                            paypackRef: result.data?.ref,
                            description: `USSD Cash-Out to ${user.phone}.`,
                        });
                        return res.status(200).send(`END Success! ${amount} RWF sent to MoMo account (${user.phone}).`);
                    } else {
                        // Refund wrapper requires amount (the exact amount deducted base)
                        // This may be out of scope if service auto-fees. We'll handle refund via service properly.
                        await walletService.creditWallet(driverId.toString(), amount, "cash_out_refund", { description: "Refund for failed cash-out" });
                        return res.status(200).send("END Gateway error. Your balance is restored.");
                    }
                }
                return res.status(200).send("END Invalid wallet option");
            }

            // 4: Fines
            if (menu === "4") {
                if (parts.length === 2) {
                    return res.status(200).send("CON Fines\n\n1 View Fines\n2 Request Fine Payment");
                }
                if (parts.length === 3 && parts[2] === "1") {
                    const fines = await Fine.find({ driverId, status: "pending" }).limit(3);
                    if (fines.length === 0) return res.status(200).send("END No pending fines.");
                    const list = fines.map((f) => `ID:${f.fineId} (${f.amount} RWF)`).join("\n");
                    return res.status(200).send(`END Pending Fines:\n${list}`);
                }
                if (parts.length === 3 && parts[2] === "2") {
                    return res.status(200).send("CON Enter Fine ID:\n(Admin will review)");
                }
                if (parts.length === 4 && parts[2] === "2") {
                    const fineId = parts[3];
                    await Fine.create({ driverId, fineId, amount: 0, status: "pending" });
                    return res.status(200).send("END Request received.\nAdmin will review.");
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
