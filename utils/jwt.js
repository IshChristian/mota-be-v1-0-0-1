const jwt = require("jsonwebtoken");

/**
 * Generate a JWT token for a user
 * @param {Object} user - The user object
 * @returns {string} JWT token
 */
function generateToken(user) {
    return jwt.sign(
        { id: user._id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );
}

/**
 * Verify a JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object} Decoded token payload
 */
function verifyToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
}

/**
 * Generate an OTP token
 * @param {string} userId - User ID
 * @param {string} otp - OTP code
 * @returns {string} JWT OTP token
 */
function generateOTPToken(userId, otp) {
    return jwt.sign(
        { userId, otp },
        process.env.JWT_SECRET,
        { expiresIn: "5m" }
    );
}

module.exports = {
    generateToken,
    verifyToken,
    generateOTPToken,
};
