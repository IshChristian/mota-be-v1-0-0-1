const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const Referral = require("../models/Referral");
const { sendSMS } = require("../services/smsService");
const authService = require("../services/authService");
const { generateOTPToken } = require("../utils/jwt");
const paymentService = require("../services/paymentService");
const Transaction = require("../models/Transaction");
const configService = require("../services/configService");

// ─── Registration & verification ──────────────────────────────────────────

const register = async (req, res) => {
    try {
        const { firstName, lastName, phone, nationalId, email, role, referralCode, password } = req.body;

        // Sanitize inputs — trim and convert empty strings to undefined
        const cleanPhone = phone?.trim() || null;
        const cleanNationalId = nationalId?.trim() || null;
        const cleanEmail = email?.trim() || null;

        if (!firstName || !lastName || !cleanPhone || !cleanNationalId) {
            return res.status(400).json({ message: "firstName, lastName, phone, and nationalId are required" });
        }

        // Only include fields in the $or query when they actually have a value
        // This prevents empty-string from causing false-positive unique index matches
        const orQuery = [
            { phone: cleanPhone },
            { nationalId: cleanNationalId },
        ];
        if (cleanEmail) orQuery.push({ email: cleanEmail });

        const existingUser = await User.findOne({ $or: orQuery });
        if (existingUser) {
            let conflict = "phone or national ID";
            let conflictValue = "";
            if (cleanEmail && existingUser.email === cleanEmail) { conflict = "email"; conflictValue = cleanEmail; }
            else if (existingUser.phone === cleanPhone) { conflict = "phone"; conflictValue = cleanPhone; }
            else if (existingUser.nationalId === cleanNationalId) { conflict = "national ID"; conflictValue = cleanNationalId; }
            console.warn(`[register] Duplicate conflict on '${conflict}': ${conflictValue}`);
            return res.status(400).json({ message: `User with this ${conflict} already exists`, conflict, value: conflictValue });
        }

        const userReferralCode = `MOTA-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

        let hashedPassword = null;
        if (password) {
            hashedPassword = await bcrypt.hash(password, 10);
        }

        const newUser = await User.create({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: cleanPhone,
            email: cleanEmail || undefined,   // store undefined so sparse index skips it
            nationalId: cleanNationalId,
            role: role || "client",
            referralCode: userReferralCode,
            password: hashedPassword,
            isActive: false, // Inactive until registration fee is paid
        });

        // If rider/driver or agent, trigger MoMo payment for registration fee
        let paymentInfo = null;
        if (newUser.role === "driver" || newUser.role === "agent") {
            const isAgent = newUser.role === "agent";
            const configKey = isAgent ? "agent_registration_fee" : "registration_fee";
            const defaultFee = isAgent ? 10000 : 5000;
            const regFee = await configService.getConfig(configKey, defaultFee);

            // Format phone for Paypack (e.g., convert +250 or 250 to 07...)
            const paypackPhone = cleanPhone.replace(/^\+?250/, '0');

            if (regFee > 0 && regFee < 100) {
                paymentInfo = { message: "Payment setup error: Fee configured below Paypack minimum (100 RWF)." };
            } else if (regFee >= 100) {
                const result = await paymentService.requestCashIn(paypackPhone, regFee, process.env.PAYPACK_ENV || "development");
                if (result.success) {
                    newUser.registrationPaypackRef = result.data?.ref;
                    await newUser.save();
                    paymentInfo = {
                        message: `Registration fee of ${regFee} RWF initiated. Please approve MoMo prompt to activate account.`,
                        ref: result.data?.ref
                    };
                } else {
                    console.error("Paypack gateway error during registration:", result.error);
                    paymentInfo = {
                        message: "Registration successful but payment gateway failed. Please retry payment later.",
                        error: result.error
                    };
                }
            } else {
                // If regFee is 0, registration is free.
                newUser.registrationPaid = true;
                newUser.registrationStatus = "pending";
                await newUser.save();
                paymentInfo = { message: "Registration is free. Account pending admin approval." };
            }
        }

        // Referral logic
        if (referralCode) {
            const referrer = await User.findOne({ referralCode });
            if (referrer) {
                await Referral.create({ referrerId: referrer._id, referredUserId: newUser._id, reward: 500, status: "pending" });
                await sendSMS(referrer.phone, `${firstName.trim()} signed up using your code! Reward pending.`, "referral_reward");
            }
        }

        // SMS Verification
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        newUser.otpToken = generateOTPToken(newUser._id, otp);
        newUser.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
        await newUser.save();

        await sendSMS(cleanPhone, `Welcome to MOTA! Your code: ${otp}.`, "registration");

        // Email Verification trigger if email exists
        if (cleanEmail) {
            const emailOtp = Math.floor(100000 + Math.random() * 900000).toString();
            newUser.emailOtpToken = generateOTPToken(newUser._id, emailOtp);
            newUser.emailOtpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 min
            await newUser.save();
            await authService.sendVerificationEmail(newUser, emailOtp);
        }

        res.status(201).json({
            message: "Registered successful. Complete payment & verification to activate.",
            userId: newUser._id,
            payment: paymentInfo
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const login = async (req, res) => {
    try {
        const { identifier, password } = req.body;

        if (!identifier || !password) {
            return res.status(400).json({ message: "identifier (phone or email) and password are required." });
        }

        // Auto-detect: if identifier contains '@' treat as email, otherwise as phone
        const isEmail = identifier.includes("@");
        const query = isEmail
            ? { email: identifier }
            : { phone: identifier };

        const user = await User.findOne(query);

        if (!user || (!user.password && !user.googleId)) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        if (user.password) {
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });
        }

        if (!user.isActive) return res.status(403).json({ message: "Account disabled" });

        // Check if 2FA is active
        if (user.twoFactorEnabled) {
            return res.status(200).json({
                message: "2FA required",
                require2FA: true,
                userId: user._id
            });
        }

        const token = authService.generateToken(user);
        res.status(200).json({ message: "Login success", token, user: { id: user._id, role: user.role } });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const logout = async (req, res) => {
    // In stateless JWT, we simply tell client to clear token.
    res.status(200).json({ message: "Logged out successfully. Clear your token." });
};

const refreshToken = async (req, res) => {
    // Basic rotation assuming valid current token
    const token = authService.generateToken(req.user);
    res.status(200).json({ token });
};

// ─── Email flows ──────────────────────────────────────────────────────────

const verifyEmail = async (req, res) => {
    try {
        const { userId, email, otp } = req.body;
        if (!otp || (!userId && !email)) {
            return res.status(400).json({ message: "userId (or email) and otp are required" });
        }

        const query = userId ? { _id: userId } : { email };
        const user = await User.findOne(query);

        if (!user || !user.emailOtpToken) {
            return res.status(400).json({ message: "Invalid state or OTP previously verified" });
        }

        const decoded = jwt.verify(user.emailOtpToken, process.env.JWT_SECRET);
        if (decoded.otp !== otp) {
            return res.status(400).json({ message: "Invalid OTP" });
        }

        user.isEmailVerified = true;
        user.emailOtpToken = undefined;
        user.emailOtpExpiry = undefined;
        await user.save();

        res.status(200).json({ message: "Email verified successfully" });
    } catch (error) {
        res.status(400).json({ message: "Invalid or expired code", error: error.message });
    }
};

const resendEmailOTP = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: "Email is required." });

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found." });
        if (user.isEmailVerified) return res.status(400).json({ message: "Email is already verified." });

        const emailOtp = Math.floor(100000 + Math.random() * 900000).toString();
        user.emailOtpToken = generateOTPToken(user._id, emailOtp);
        user.emailOtpExpiry = new Date(Date.now() + 5 * 60 * 1000);
        await user.save();

        await authService.sendVerificationEmail(user, emailOtp);

        res.status(200).json({ message: "New email OTP sent successfully." });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.status(404).json({ message: "Account not found" });

        await authService.sendPasswordResetEmail(user);
        res.status(200).json({ message: "Password reset email sent" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const resetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.action !== "reset_password") throw new Error("Invalid token");

        const user = await User.findById(decoded.id);
        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.status(200).json({ message: "Password successfully reset" });
    } catch (error) {
        res.status(400).json({ message: "Invalid or expired request", error: error.message });
    }
};

// ─── 2FA flows ────────────────────────────────────────────────────────────

const setup2FA = async (req, res) => {
    try {
        const data = await authService.setup2FA(req.user.id);
        res.status(200).json({ message: "2FA setup initiated", data });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const verify2FA = async (req, res) => {
    try {
        const { token, userId } = req.body;

        // If coming from login, we might not have req.user yet, so we pass userId
        const targetUserId = req.user ? req.user.id : userId;
        const user = await User.findById(targetUserId);

        const isValid = authService.verify2FA(user.twoFactorSecret, token);
        if (!isValid) return res.status(401).json({ message: "Invalid 2FA code" });

        if (!user.twoFactorEnabled) {
            user.twoFactorEnabled = true;
            await user.save();
        }

        const jwtToken = authService.generateToken(user);
        res.status(200).json({ message: "2FA verified", token: jwtToken });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// Expose legacy OTP
const verifyOTP = async (req, res) => {
    // ... Copy legacy logic easily or import existing 
    const { userId, otp } = req.body;
    const user = await User.findById(userId);
    if (!user || !user.otpToken) return res.status(400).json({ message: "Invalid state" });

    try {
        const decoded = jwt.verify(user.otpToken, process.env.JWT_SECRET);
        if (decoded.otp !== otp) return res.status(400).json({ message: "Invalid OTP" });

        user.isVerified = true;
        user.otpToken = null;
        user.otpExpiry = null;
        await user.save();
        res.status(200).json({ message: "Phone verified" });
    } catch (err) {
        res.status(400).json({ message: "Code expired" });
    }
};

/**
 * Check if registration fee was paid and activate account
 */
const checkRegistrationPayment = async (req, res) => {
    try {
        const { userId } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.registrationPaid) return res.status(200).json({ message: "Already paid and active", active: true });

        if (!user.registrationPaypackRef) {
            return res.status(400).json({ message: "No registration payment found for this user." });
        }

        // Check Paypack status
        const result = await paymentService.checkTransaction(user.registrationPaypackRef);
        if (result.success && result.data.status === "successful") {
            user.registrationPaid = true;
            // Removed: user.isActive = true;
            // Now we mark it as pending for admin approval
            user.registrationStatus = "pending";
            if (user.role === "agent") {
                user.kycLevel = "full";
            }
            await user.save();

            return res.status(200).json({ message: "Payment successful. Account pending admin approval.", active: false, status: user.registrationStatus });
        } else {
            return res.status(200).json({ message: "Payment pending or failed.", active: false, status: result.data?.status });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Resend OTP for phone verification
 */
const resendOTP = async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ message: "Phone number is required." });

        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ message: "User not found." });
        if (user.isVerified) return res.status(400).json({ message: "User is already verified." });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpToken = generateOTPToken(user._id, otp);
        user.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
        await user.save();

        await sendSMS(phone, `MOTA: Your new verification code is ${otp}.`, "registration");

        res.status(200).json({ message: "New OTP sent successfully." });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Initiate registration fee payment manually
 */
const payRegistration = async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ message: "Phone number is required." });

        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ message: "User not found." });
        if (user.registrationPaid) return res.status(400).json({ message: "Account is already active." });

        if (user.role !== "driver" && user.role !== "agent") {
            return res.status(400).json({ message: "Payment only applies to driver or agent roles." });
        }

        const isAgent = user.role === "agent";
        const configKey = isAgent ? "agent_registration_fee" : "registration_fee";
        const defaultFee = isAgent ? 10000 : 5000;
        const regFee = await configService.getConfig(configKey, defaultFee);

        // Format phone for Paypack (e.g., convert +250 or 250 to 07...)
        const paypackPhone = user.phone.replace(/^\+?250/, '0');

        if (regFee > 0 && regFee < 100) {
            return res.status(400).json({ message: "System configuration error: Registration fee is below the minimum allowed by the gateway (100 RWF)." });
        } else if (regFee === 0) {
            user.registrationPaid = true;
            user.registrationStatus = "pending";
            await user.save();
            return res.status(200).json({ message: "Registration is currently free. Account is now pending admin approval." });
        }

        const result = await paymentService.requestCashIn(paypackPhone, regFee, process.env.PAYPACK_ENV || "development");

        if (result.success) {
            user.registrationPaypackRef = result.data?.ref;
            await user.save();
            return res.status(200).json({
                message: `Payment request of ${regFee} RWF initiated. Please approve MoMo prompt to activate account.`,
                ref: result.data?.ref
            });
        } else {
            return res.status(500).json({ message: "Payment gateway error. Could not initiate payment.", error: result.error });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    register,
    login,
    logout,
    refreshToken,
    verifyEmail,
    forgotPassword,
    resetPassword,
    setup2FA,
    verify2FA,
    verifyOTP,
    checkRegistrationPayment,
    resendOTP,
    payRegistration,
    resendEmailOTP,
};
