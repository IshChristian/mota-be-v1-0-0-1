const SystemConfig = require("../models/SystemConfig");

// ─── In-memory cache ────────────────────────────────────────────────────────
let configCache = {};

// ─── Default settings to seed on first startup ──────────────────────────────
const DEFAULT_SETTINGS = [
    // Fuel support
    { key: "fuel_voucher_amount", value: 1000, category: "financial", dataType: "number", description: "Value of one fuel voucher in RWF" },
    { key: "fuel_voucher_daily_limit", value: 2, category: "financial", dataType: "number", description: "Fuel vouchers a driver may request per Kigali day, per type (QR and MoMo)" },
    { key: "fuel_voucher_min_tier", value: "Gold", category: "financial", dataType: "string", description: "Lowest driver tier allowed to request fuel vouchers (Bronze, Silver, Gold, Platinum)" },
    { key: "fuel_voucher_momo_enabled", value: true, category: "financial", dataType: "boolean", description: "Allow MoMo fuel vouchers (paid out through the withdrawal pipeline)" },
    { key: "fuel_stations", value: "[]", category: "general", dataType: "string", description: "Partner fuel stations as JSON: [{\"id\",\"name\",\"address\",\"latitude\",\"longitude\",\"acceptsQr\"}]" },
    // Ride pricing (admin panel → Settings → Ride pricing). Fare = base + km × per-km rate, never below the minimum.
    { key: "ride_base_fare", value: 500, category: "financial", dataType: "number", description: "Moto: base fare in RWF" },
    { key: "ride_per_km_rate", value: 500, category: "financial", dataType: "number", description: "Moto: price per km in RWF" },
    { key: "ride_minimum_fare", value: 500, category: "financial", dataType: "number", description: "Moto: minimum fare in RWF" },
    { key: "car_ride_base_fare", value: 1500, category: "financial", dataType: "number", description: "Car: base fare in RWF" },
    { key: "car_ride_per_km_rate", value: 500, category: "financial", dataType: "number", description: "Car: price per km in RWF" },
    { key: "car_ride_minimum_fare", value: 2500, category: "financial", dataType: "number", description: "Car: minimum fare in RWF" },
    { key: "parcel_surcharge", value: 300, category: "financial", dataType: "number", description: "Extra RWF added to parcel deliveries" },

    // Financial
    { key: "ride_commission_percentage", value: 10, category: "financial", dataType: "percentage", description: "Platform commission % deducted from ride fares" },
    { key: "cash_out_fee_percentage", value: 2, category: "financial", dataType: "percentage", description: "Fee % charged on driver cash-out withdrawals" },
    { key: "agent_cash_in_fee_percentage", value: 0, category: "financial", dataType: "percentage", description: "Fee % charged on agent cash-in deposits" },
    { key: "referral_reward_amount", value: 5000, category: "financial", dataType: "number", description: "Referral reward amount in RWF" },
    { key: "agent_registration_fee", value: 10000, category: "financial", dataType: "number", description: "Agent registration fee in RWF" },
    { key: "registration_fee", value: 5000, category: "financial", dataType: "number", description: "Driver registration fee in RWF" },
    { key: "transfer_fee_percentage", value: 1, category: "financial", dataType: "percentage", description: "Fee % charged on P2P wallet transfers" },
    { key: "fine_interest_rate", value: 5, category: "financial", dataType: "percentage", description: "Interest % applied to approved fines" },

    // Loan
    { key: "fine_loan_interest_rate", value: 5, category: "loan", dataType: "percentage", description: "Interest rate % applied to fine loans" },
    { key: "fine_loan_max_amount", value: 50000, category: "loan", dataType: "number", description: "Maximum fine loan amount in RWF" },
    { key: "fine_loan_auto_repayment_percentage", value: 10, category: "loan", dataType: "percentage", description: "Auto-deduction % from ride payments for loan repayment" },
    { key: "fine_loan_max_duration_days", value: 90, category: "loan", dataType: "number", description: "Maximum loan duration in days" },

    // General
    { key: "app_name", value: "MOTA", category: "general", dataType: "string", description: "Platform display name" },
    { key: "support_phone", value: "+250788000000", category: "general", dataType: "string", description: "Support phone number" },
    { key: "support_email", value: "support@mota.rw", category: "general", dataType: "string", description: "Support email address" },
    { key: "maintenance_mode", value: false, category: "general", dataType: "boolean", description: "Pause the driver and passenger apps (staff keep access)" },
    { key: "maintenance_message", value: "MOTA is being updated. Please try again shortly.", category: "general", dataType: "string", description: "Message shown in the apps during maintenance" },

    // Daily fuel reward (cron): QR vouchers given each day to drivers on a lifetime tier.
    { key: "fuel_reward_enabled", value: true, category: "financial", dataType: "boolean", description: "Give daily reward fuel vouchers" },
    { key: "fuel_reward_tier", value: "silver", category: "financial", dataType: "string", description: "Lifetime tier that receives the daily reward vouchers (starter, bronze, silver, gold, platinum, gorilla)" },
    { key: "fuel_reward_count", value: 2, category: "financial", dataType: "number", description: "Reward vouchers per driver per day" },
    { key: "fuel_reward_amount", value: 3000, category: "financial", dataType: "number", description: "Value of one reward voucher in RWF" },

    // Monthly performance tiers (unlock fuel vouchers, earnings multiplier)
    { key: "perf_tier_silver_monthly_rides", value: 600, category: "general", dataType: "number", description: "Rides this month to reach Silver performance tier" },
    { key: "perf_tier_gold_monthly_rides", value: 800, category: "general", dataType: "number", description: "Rides this month to reach Gold performance tier" },
    { key: "perf_tier_platinum_monthly_rides", value: 1000, category: "general", dataType: "number", description: "Rides this month to reach Platinum performance tier" },
    { key: "perf_multiplier_silver", value: 1.2, category: "financial", dataType: "number", description: "Earnings multiplier at Silver performance tier" },
    { key: "perf_multiplier_gold", value: 1.5, category: "financial", dataType: "number", description: "Earnings multiplier at Gold performance tier" },
    { key: "perf_multiplier_platinum", value: 2, category: "financial", dataType: "number", description: "Earnings multiplier at Platinum performance tier" },
    { key: "perf_base_daily_pay", value: 22000, category: "financial", dataType: "number", description: "Base daily pay in RWF shown to drivers (before the multiplier)" },
    { key: "perf_daily_streak_target", value: 20, category: "general", dataType: "number", description: "Rides in a day that count towards a streak" },

    // Tier Thresholds (Lifetime Rides)
    { key: "tier_bronze_rides", value: 600, category: "general", dataType: "number", description: "Total rides required for Bronze tier" },
    { key: "tier_silver_rides", value: 1500, category: "general", dataType: "number", description: "Total rides required for Silver tier" },
    { key: "tier_gold_rides", value: 5000, category: "general", dataType: "number", description: "Total rides required for Gold tier" },
    { key: "tier_platinum_rides", value: 100000, category: "general", dataType: "number", description: "Total rides required for Platinum tier" },
    { key: "tier_gorilla_rides", value: 1000000, category: "general", dataType: "number", description: "Total rides required for Gorilla tier" },
];

// ─── Seed defaults (upsert — won't overwrite existing values) ───────────────
const seedDefaults = async () => {
    let seeded = 0;
    for (const setting of DEFAULT_SETTINGS) {
        const existing = await SystemConfig.findOne({ key: setting.key });
        if (!existing) {
            await SystemConfig.create(setting);
            seeded++;
        }
    }
    if (seeded > 0) {
        console.log(`⚙️  Seeded ${seeded} default system settings`);
    }
    await refreshCache();
};

// ─── Cache ──────────────────────────────────────────────────────────────────
const refreshCache = async () => {
    const configs = await SystemConfig.find({});
    const newCache = {};
    configs.forEach((c) => {
        newCache[c.key] = c.value;
    });
    configCache = newCache;
};

// ─── Get single setting (cached) ────────────────────────────────────────────
const getSetting = async (key, defaultValue) => {
    if (configCache[key] !== undefined) {
        return configCache[key];
    }
    const config = await SystemConfig.findOne({ key });
    if (config) {
        configCache[key] = config.value;
        return config.value;
    }
    return defaultValue;
};

// ─── Get all settings (optionally filtered by category) ─────────────────────
const getAllSettings = async (category = null) => {
    const filter = category ? { category } : {};
    return await SystemConfig.find(filter)
        .populate("updatedBy", "firstName lastName")
        .sort({ category: 1, key: 1 });
};

// ─── Update single setting ──────────────────────────────────────────────────
const updateSetting = async (key, value, userId = null) => {
    const config = await SystemConfig.findOneAndUpdate(
        { key },
        { value, updatedBy: userId },
        { upsert: true, returnDocument: "after" }
    );
    configCache[key] = value;
    return config;
};

// ─── Bulk update settings ───────────────────────────────────────────────────
const bulkUpdate = async (settings, userId = null) => {
    const results = [];
    for (const { key, value } of settings) {
        const config = await SystemConfig.findOneAndUpdate(
            { key },
            { value, updatedBy: userId },
            { returnDocument: "after" }
        );
        if (config) {
            configCache[key] = value;
            results.push(config);
        }
    }
    return results;
};

module.exports = {
    seedDefaults,
    refreshCache,
    getSetting,
    getAllSettings,
    updateSetting,
    bulkUpdate,
    // Backward-compatible aliases for configService users
    getConfig: getSetting,
    setConfig: updateSetting,
};
