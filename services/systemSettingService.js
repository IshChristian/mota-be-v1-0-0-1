const SystemConfig = require("../models/SystemConfig");

// ─── In-memory cache ────────────────────────────────────────────────────────
let configCache = {};

// ─── Default settings to seed on first startup ──────────────────────────────
const DEFAULT_SETTINGS = [
    // Financial
    { key: "ride_commission_percentage", value: 10, category: "financial", dataType: "percentage", description: "Platform commission % deducted from ride fares" },
    { key: "cash_out_fee_percentage", value: 2, category: "financial", dataType: "percentage", description: "Fee % charged on driver cash-out withdrawals" },
    { key: "agent_cash_in_fee_percentage", value: 0, category: "financial", dataType: "percentage", description: "Fee % charged on agent cash-in deposits" },
    { key: "referral_reward_amount", value: 5000, category: "financial", dataType: "number", description: "Referral reward amount in RWF" },
    { key: "agent_registration_fee", value: 10000, category: "financial", dataType: "number", description: "Agent registration fee in RWF" },
    { key: "registration_fee", value: 5000, category: "financial", dataType: "number", description: "Driver registration fee in RWF" },

    // Loan
    { key: "fine_loan_interest_rate", value: 5, category: "loan", dataType: "percentage", description: "Interest rate % applied to fine loans" },
    { key: "fine_loan_max_amount", value: 50000, category: "loan", dataType: "number", description: "Maximum fine loan amount in RWF" },
    { key: "fine_loan_auto_repayment_percentage", value: 10, category: "loan", dataType: "percentage", description: "Auto-deduction % from ride payments for loan repayment" },
    { key: "fine_loan_max_duration_days", value: 90, category: "loan", dataType: "number", description: "Maximum loan duration in days" },

    // General
    { key: "app_name", value: "MOTA", category: "general", dataType: "string", description: "Platform display name" },
    { key: "support_phone", value: "+250788000000", category: "general", dataType: "string", description: "Support phone number" },
    { key: "support_email", value: "support@mota.rw", category: "general", dataType: "string", description: "Support email address" },
    { key: "maintenance_mode", value: false, category: "general", dataType: "boolean", description: "Enable/disable platform maintenance mode" },

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
        { upsert: true, new: true }
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
            { new: true }
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
