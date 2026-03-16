const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Middleware to authenticate JWT token
 * Extracts token from Authorization header and attaches user to request
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Access denied. No token provided." });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password -otpToken").populate("roleId", "name permissions");
    if (!user) {
      return res.status(401).json({ message: "Invalid token. User not found." });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "Account is deactivated. Contact admin." });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired. Please login again." });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token." });
    }
    return res.status(500).json({ message: "Authentication error", error: error.message });
  }
};

/**
 * RBAC authorization middleware
 * Usage: authorize("user:delete", "admin:access")
 */
const authorize = (...permissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // Admins bypass permission checks
    if (req.user.role === "admin") {
      return next();
    }

    const userPermissions = req.user.roleId?.permissions || [];

    // Check if user has ALL required permissions (or at least one? Let's go with ALL required for this route, or we can use ANY. Let's do ANY for flexibility or require exact).
    // Usually, you might want to check if user has at least one of the required permissions, or all. Let's check for ALL permissions passed.
    const hasPermission = permissions.every(p => userPermissions.includes(p));

    if (!hasPermission) {
      return res.status(403).json({ message: "Forbidden. Insufficient permissions." });
    }

    next();
  };
};

module.exports = {
  protect,
  authorize,
};
