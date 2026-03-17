const mongoose = require("mongoose");

const tierSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
    },
    totalRides: { type: Number, default: 0 },
    monthlyRides: { type: Number, default: 0 },
    tier: {
        type: String,
        enum: ["starter", "bronze", "silver", "gold", "platinum", "gorilla"],
        default: "starter",
    },
    multiplier: { type: Number, default: 1.0 },
    month: { type: Number },
    year: { type: Number },
    updatedAt: { type: Date, default: Date.now },
});

tierSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

tierSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const Tier = mongoose.model("Tier", tierSchema);

module.exports = Tier;
