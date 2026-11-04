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
                    // Rewards are QR vouchers that expire at Kigali midnight and do not
                    // count against the driver's own daily request limit.
                    user.fuelVouchers.push({
                        code: voucherCode,
                        type: "qr",
                        source: "reward",
                        status: "active",
                        amount: 3000,
                        issuedAt: new Date(),
                        expiresAt: require("./fuelVoucherService").kigaliMidnight(),
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
        
        try {
            const reminders = await require("./repaymentService").sendUpcomingReminders();
            if (reminders) console.log(`Sent ${reminders} loan installment reminders.`);
        } catch (reminderErr) {
            console.error("Loan reminders failed:", reminderErr.message);
        }

        console.log(`✅ Daily tasks successfully executed. Distributed ${vouchersDistributed} Fuel Vouchers to Tier 2 drivers.`);
    } catch (err) {
        console.error("❌ Daily tasks failed:", err.message);
    }
};

const runLoanChecks = async () => {
    try {
        const repaymentService = require("./repaymentService");
        const loanService = require("./loanService");
        const overdue = await repaymentService.checkOverdueInstallments();
        const defaulted = await loanService.checkOverdueLoans();
        if (overdue || defaulted) console.log(`Loans: ${overdue} now overdue, ${defaulted} defaulted.`);
    } catch (err) {
        console.error("Loan checks failed:", err.message);
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
            // Check Paypack Events directly for this ref
            const ppStatusResult = await paymentService.getEvents({ ref: item.ref });
            
            if (ppStatusResult.success && ppStatusResult.data && ppStatusResult.data.transactions && ppStatusResult.data.transactions.length > 0) {
                // The newest event is usually the first or last, let's sort or just take the one with terminal status
                const events = ppStatusResult.data.transactions;
                
                // Find the event data block (Paypack's event returns an array, each has .data which contains the actual webhook payload)
                // Let's get the most definitive event (e.g., successful or failed)
                let latestEventData = events[0].data; 
                for (const ev of events) {
                    if (ev.data && (ev.data.status === "successful" || ev.data.status === "failed")) {
                        latestEventData = ev.data;
                    }
                }

                if (latestEventData) {
                    const realStatus = latestEventData.status;
                    
                    // If the event status differs from our local pending status
                    if (item.status !== realStatus && (realStatus === "successful" || realStatus === "failed")) {
                        const fakeReq = { body: { data: latestEventData } };
                        const fakeRes = { status: () => ({ json: () => {} }) };
                        
                        // Route the raw event through the webhook handler
                        await paymentController.handleWebhook(fakeReq, fakeRes);
                        console.log(`[Auto-Sync] Fixed out-of-sync transaction using Event Log: ${item.ref} -> ${realStatus}`);
                    }
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
    // Withdrawals left mid-dispatch by a restart go to staff (every 5 minutes).
    setInterval(() => {
        require("./withdrawalService").recoverStuckDispatches().catch((error) => console.error("Stuck withdrawal check failed:", error.message));
    }, 5 * 60 * 1000);
    require("./supportAlerts").startSupportAlerts();
    // Basic polling cron - checks every hour if the day has changed since last run
    setInterval(() => {
        const today = new Date().toDateString();
        if (today !== lastRunDate) {
            lastRunDate = today;
            runDailyTasks();
        }
    }, 60 * 60 * 1000); // Check every 1 hour

    // Loans: missed installments → overdue (one SMS on the change); past the final due date → defaulted.
    setInterval(runLoanChecks, 60 * 60 * 1000);

    // Realtime background sync poller - checks every 1 second for stuck pending transactions
    setInterval(() => {
        runTransactionSync();
    }, 1000);

    // Expire stale ride requests every 10 seconds
    const rideEngineService = require("./rideEngineService");
    const processScheduled = () => rideEngineService.processScheduledRides().catch((error) => console.error("Scheduled rides failed:", error));
    void processScheduled();
    setInterval(processScheduled, 60 * 1000);
    setInterval(async () => {
        try {
            await rideEngineService.expireStaleRequests();
        } catch (error) {
            console.error("Auto-expire stale rides failed:", error.message);
        }
    }, 10000);

    console.log("⏱️  Daily Cron & Realtime Sync Service initialized.");
};

module.exports = { initCron, runDailyTasks, runTransactionSync };
