const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    email: { type: String, unique: true, sparse: true, trim: true },
    nationalId: { type: String, unique: true, sparse: true, trim: true }, // Made sparse for social logins
    avatarUrl: { type: String },
    avatarId: { type: mongoose.Schema.Types.ObjectId, ref: "Upload" },
    role: {
        type: String,
        required: true,
        enum: ["driver", "agent", "admin", "user", "manager", "moderator"],
        default: "driver",
    },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role" },
    password: { type: String },
    otpToken: { type: String },
    otpExpiry: { type: Date },
    emailOtpToken: { type: String },
    emailOtpExpiry: { type: Date },
    isVerified: { type: Boolean, default: false }, // Phone verified
    isEmailVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: false }, // Default to false until admin approves
    registrationStatus: { 
        type: String, 
        enum: ["pending", "correction", "approved"], 
        default: "pending" 
    },
    // 2FA Fields
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String },
    // Social Login
    googleId: { type: String, sparse: true, unique: true },
    githubId: { type: String, sparse: true, unique: true },
    kycLevel: {
        type: String,
        enum: ["basic", "full"],
        default: "basic",
    },
    referralCode: { type: String, unique: true, sparse: true },
    registrationPaid: { type: Boolean, default: false },
    registrationPaypackRef: { type: String },
    fuelVouchers: [{
        code: String,
        amount: Number,
        issuedAt: { type: Date, default: Date.now },
        isUsed: { type: Boolean, default: false }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

// Convert empty strings to undefined for sparse-unique fields.
// MongoDB sparse indexes only skip null/undefined — NOT empty strings.
// Without this, two users with email: "" would throw a duplicate key error.
userSchema.pre("validate", function () {
    if (this.email === "") this.email = undefined;
    if (this.nationalId === "") this.nationalId = undefined;
    if (this.googleId === "") this.googleId = undefined;
    if (this.githubId === "") this.githubId = undefined;
    if (this.referralCode === "") this.referralCode = undefined;
});

userSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

userSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

// Register model as "User" so `ref: "User"` works in other schemas. 
// Mongoose will automatically use the "users" collection.
const User = mongoose.model("User", userSchema);

module.exports = User;
