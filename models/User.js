const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    nationalId: { type: String, required: true, unique: true, trim: true },
    role: {
        type: String,
        required: true,
        enum: ["driver", "agent", "admin"],
        default: "driver",
    },
    password: { type: String },
    otpToken: { type: String },
    otpExpiry: { type: Date },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    kycLevel: {
        type: String,
        enum: ["basic", "full"],
        default: "basic",
    },
    referralCode: { type: String, unique: true, sparse: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

userSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

userSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const User = mongoose.model("User", userSchema);

module.exports = User;
