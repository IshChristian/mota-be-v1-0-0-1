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

let isSyncing = false;

const runTransactionSync = async () => {
    if (isSyncing) return; // Prevent overlapping API calls if Paypack is slow
    isSyncing = true;

    try {
        const Transaction = require("../models/Transaction");
        const User = require("../models/User");
        const paymentService = require("./paymentService");
        const paymentController = require("../controllers/paymentController");

        let pendingRefs = [];

        // Find all pending wallet transactions
        const pendingTxs = await Transaction.find({ status: "pending", paypackRef: { $ne: null } });
        for (const t of pendingTxs) pendingRefs.push({ ref: t.paypackRef, status: t.status });

        // Find all pending registration payments
        const pendingUsers = await User.find({ registrationPaid: false, registrationPaypackRef: { $ne: null } });
        for (const u of pendingUsers) pendingRefs.push({ ref: u.registrationPaypackRef, status: "pending" });

        for (const item of pendingRefs) {
            const ppStatusResult = await paymentService.getTransactionStatus(item.ref);
            
            if (ppStatusResult.success && ppStatusResult.data) {
                const realStatus = ppStatusResult.data.status;
                
                // If Paypack status is terminal (successful or failed) and local is still pending
                if (item.status !== realStatus && (realStatus === "successful" || realStatus === "failed" || realStatus === "completed")) {
                    const fakeEvent = {
                        ref: ppStatusResult.data.ref,
                        status: realStatus,
                        amount: ppStatusResult.data.amount,
                        kind: ppStatusResult.data.kind
                    };
                    
                    const fakeReq = { body: { data: fakeEvent } };
                    const fakeRes = { status: () => ({ json: () => {} }) };
                    
                    // Route it through the official webhook handler so wallet/streak/registration updates run identically
                    await paymentController.handleWebhook(fakeReq, fakeRes);
                    console.log(`[Auto-Sync] Fixed out-of-sync transaction: ${item.ref} -> ${realStatus}`);
                }
            }
        }
    } catch (err) {
        console.error("Auto-sync background task failed:", err.message);
    } finally {
        isSyncing = false;
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

    // Realtime background sync poller - checks every 1 second for stuck pending transactions
    setInterval(() => {
        runTransactionSync();
    }, 1000);

    console.log("⏱️  Daily Cron & Realtime Sync Service initialized.");
};

module.exports = { initCron, runDailyTasks, runTransactionSync };
