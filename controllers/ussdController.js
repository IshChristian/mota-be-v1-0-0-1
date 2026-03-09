const User = require("../models/User");
const DriverProfile = require("../models/DriverProfile");
const Ride = require("../models/Ride");
const Fine = require("../models/Fine");
const { getTierInfo } = require("../services/tierService");
const { getStreakInfo, DAILY_TARGET } = require("../services/streakService");

/**
 * Handle USSD requests
 * POST /api/ussd
 */
const handleUssd = async (req, res) => {
    let { sessionId, serviceCode, phoneNumber, text } = req.body;
    let response = "";

    // Safely handle missing phone
    if (!phoneNumber) {
        phoneNumber = "";
    }

    // Attempt to normalize phone format assuming it comes like 078... or 250...
    let formattedPhone = phoneNumber;
    if (formattedPhone.startsWith("0")) {
        formattedPhone = "+250" + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith("250")) {
        formattedPhone = "+" + formattedPhone;
    }

    try {
        const user = await User.findOne({ $or: [{ phone: formattedPhone }, { phone: phoneNumber }] });

        if (!user || user.role !== "driver") {
            response = "END This number is not registered with MOTA";
            res.set("Content-Type", "text/plain");
            return res.status(200).send(response);
        }

        const driverId = user._id;

        if (!text) {
            // First screen
            response = "CON Welcome to MOTA\n\n1 Kinyarwanda\n2 English";
        } else {
            const inputArray = text.split("*");
            const language = inputArray[0];

            if (inputArray.length === 1) {
                // Language selected, show main menu
                if (language === "1" || language === "2") {
                    response = "CON MOTA Services\n\n1 Dashboard\n2 Rides\n3 Fines\n4 Wallet\n5 Tier Status\n6 Referral\n0 Exit";
                } else {
                    response = "END Invalid selection";
                }
            } else if (inputArray.length >= 2) {
                const menuOption = inputArray[1];

                if (menuOption === "1") {
                    // Dashboard
                    const streakInfo = await getStreakInfo(driverId);
                    response = `END Dashboard\nToday: ${streakInfo.todayRideCount}/${DAILY_TARGET} rides\nStreak: ${streakInfo.currentStreak} days`;
                } else if (menuOption === "2") {
                    // Rides
                    const now = new Date();
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                    const ridesMonth = await Ride.countDocuments({
                        driverId,
                        createdAt: { $gte: startOfMonth },
                    });
                    response = `END Rides\nMonthly Total: ${ridesMonth}\nKeep up the good work!`;
                } else if (menuOption === "3") {
                    // Fines Flow
                    if (inputArray.length === 2) {
                        response = "CON Fines\n\n1 View Fines\n2 Request Fine Payment";
                    } else if (inputArray.length === 3 && inputArray[2] === "2") {
                        response = "CON Enter Fine ID";
                    } else if (inputArray.length === 4 && inputArray[2] === "2") {
                        const fineId = inputArray[3];

                        const newFine = new Fine({
                            driverId,
                            fineId,
                            amount: 0, // Admin sets this upon review if required
                            status: "pending"
                        });
                        await newFine.save();

                        response = "END Request received.\nAdmin will review and you will receive SMS after approval.";
                    } else {
                        response = "END Invalid Fine Option";
                    }
                } else if (menuOption === "4") {
                    // Wallet
                    const profile = await DriverProfile.findOne({ driverId });
                    response = `END Wallet Balance:\n${profile ? profile.wallet : 0} RWF`;
                } else if (menuOption === "5") {
                    // Tier Status
                    const tierInfo = await getTierInfo(driverId);
                    response = `END Tier: ${tierInfo.tier.toUpperCase()}\nMultiplier: ${tierInfo.multiplier}x`;
                } else if (menuOption === "6") {
                    // Referral
                    response = `END Your Referral Code:\n${user.referralCode}`;
                } else if (menuOption === "0") {
                    // Exit
                    response = "END Thank you for using MOTA!";
                } else {
                    response = "END Invalid Option";
                }
            }
        }

        res.set("Content-Type", "text/plain");
        res.status(200).send(response);
    } catch (error) {
        console.error("USSD Error:", error);
        res.set("Content-Type", "text/plain");
        res.status(200).send("END System error. Please try again later.");
    }
};

module.exports = {
    handleUssd,
};
