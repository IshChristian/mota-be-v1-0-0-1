const User = require("../models/User");
const Tier = require("../models/Tier");
const crypto = require("crypto");
const { sendSMS } = require("./smsService");

let lastRunDate = new Date().toDateString();

const runDailyTasks = async () => {
    try {
        console.log("⏳ Starting daily cron tasks...");

        // 1. Distribute Fuel Vouchers to Tier 2 (Silver) users
        // "tier 2" typically translates to "silver" in our tier structure
        const tier2Drivers = await Tier.find({ tier: "silver" });
        
        let vouchersDistributed = 0;
        for (const t of tier2Drivers) {
            const user = await User.findById(t.driverId);
            
            // Only reward active drivers
            if (user && user.isActive) {
                // Add two fuel vouchers of 3000 RWF each
                for (let i = 0; i < 2; i++) {
                    const voucherCode = `FUEL-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
                    user.fuelVouchers.push({
                        code: voucherCode,
                        amount: 3000, 
                        issuedAt: new Date(),
                        isUsed: false
                    });
                }
                await user.save();
                vouchersDistributed += 2;

                // Optionally send SMS Notification to inform driver
                if (user.phone) {
                    await sendSMS(
                        user.phone, 
                        `MOTA Rewards: You just received your 2 daily Fuel Vouchers (3000 RWF each)! Check your app to redeem them.`, 
                        "reward"
                    );
                }
            }
        }
        
        console.log(`✅ Daily tasks successfully executed. Distributed ${vouchersDistributed} Fuel Vouchers to Tier 2 drivers.`);
    } catch (err) {
        console.error("❌ Daily tasks failed:", err.message);
    }
};

const initCron = () => {
    // Basic polling cron - checks every hour if the day has changed since last run
    setInterval(() => {
        const today = new Date().toDateString();
        if (today !== lastRunDate) {
            lastRunDate = today;
            runDailyTasks();
        }
    }, 60 * 60 * 1000); // Check every 1 hour

    console.log("⏱️  Daily Cron Service initialized.");
};

module.exports = { initCron, runDailyTasks };
