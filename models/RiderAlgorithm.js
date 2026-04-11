const mongoose = require("mongoose");

const riderAlgorithmSchema = new mongoose.Schema({
    riderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
        index: true,
    },
    daily_rides: { type: Number, default: 0 },
    monthly_rides: { type: Number, default: 0 },
    current_tier: {
        type: String,
        enum: ["Bronze", "Silver", "Gold", "Platinum"],
        default: "Bronze",
    },
    streak_days: { type: Number, default: 0 },
    last_ride_date: { type: Date },
    fines_paid: { type: Number, default: 0 },
    fuel_vouchers_used: { type: Number, default: 0 },
    features_unlocked: [{ type: String }],
    trophies: [{ type: String }],
    first_activity_date: { type: Date },
    // Cycle tracking
    cycle_number: { type: Number, default: 1 },
    previous_cycles: [{
        cycle_number: Number,
        monthly_rides: Number,
        tier: String,
        streak_days: Number,
        trophies: [String],
        ended_at: Date,
    }],
    // Daily pay tracking
    daily_earnings: { type: Number, default: 0 },
    total_earnings: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
});

riderAlgorithmSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

riderAlgorithmSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const RiderAlgorithm = mongoose.model("RiderAlgorithm", riderAlgorithmSchema);

module.exports = RiderAlgorithm;
