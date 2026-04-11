const { dailyResetJob, monthlyResetJob } = require("../services/algorithmService");

/**
 * MOTA Scheduler
 * 
 * Uses simple setInterval-based scheduling for the MOTA Algorithm Engine.
 * For production, consider switching to node-cron or external schedulers.
 * 
 * Jobs:
 * 1. dailyResetJob()  — Runs at 00:00 (midnight), resets daily_rides
 * 2. monthlyResetJob() — Runs daily, checks each rider's 30-day cycle
 */

let dailyTimer = null;
let monthlyTimer = null;

/**
 * Calculate milliseconds until next midnight
 */
const msUntilMidnight = () => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 0, 0);
    return midnight - now;
};

/**
 * Start the scheduler
 */
const startScheduler = () => {
    console.log("⏰ MOTA Scheduler starting...");

    // ─── Daily Reset at Midnight ─────────────────────────────────────
    const scheduleDailyReset = () => {
        const msToMidnight = msUntilMidnight();
        console.log(`⏰ Daily reset scheduled in ${Math.round(msToMidnight / 1000 / 60)} minutes`);

        dailyTimer = setTimeout(async () => {
            try {
                console.log("🕐 Running daily reset job...");
                await dailyResetJob();

                // Also check monthly resets
                console.log("📅 Running monthly cycle check...");
                await monthlyResetJob();
            } catch (error) {
                console.error("❌ Scheduler job failed:", error.message);
            }

            // Re-schedule for next midnight
            scheduleDailyReset();
        }, msToMidnight);
    };

    scheduleDailyReset();

    // ─── Monthly Check every 6 hours (backup) ───────────────────────
    monthlyTimer = setInterval(async () => {
        try {
            console.log("📅 Periodic monthly cycle check...");
            await monthlyResetJob();
        } catch (error) {
            console.error("❌ Monthly check failed:", error.message);
        }
    }, 6 * 60 * 60 * 1000); // Every 6 hours

    console.log("✅ MOTA Scheduler running");
};

/**
 * Stop the scheduler
 */
const stopScheduler = () => {
    if (dailyTimer) {
        clearTimeout(dailyTimer);
        dailyTimer = null;
    }
    if (monthlyTimer) {
        clearInterval(monthlyTimer);
        monthlyTimer = null;
    }
    console.log("⏹️ MOTA Scheduler stopped");
};

module.exports = {
    startScheduler,
    stopScheduler,
};
