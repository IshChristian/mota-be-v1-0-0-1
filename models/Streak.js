const mongoose = require("mongoose");

const streakSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
    },
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    lastRideDate: { type: Date },
    todayRideCount: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
});

streakSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

streakSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const Streak = mongoose.model("Streak", streakSchema);

module.exports = Streak;
