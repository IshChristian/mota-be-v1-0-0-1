const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
        index: true,
    },
    balance: {
        type: Number,
        default: 0,
        min: 0,
    },
    fuelCredits: {
        type: Number,
        default: 0,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

walletSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

walletSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const Wallet = mongoose.model("Wallet", walletSchema);

module.exports = Wallet;
