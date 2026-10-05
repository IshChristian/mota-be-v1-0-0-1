const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Session = require("../models/Session");
const { STAFF_ROLE_TEMPLATES } = require("../constants/staffRoles");

/**
 * Middleware to authenticate JWT token
 * Extracts token from Authorization header and attaches user to request
 */
const authenticate = (allowOnboarding = false, statusOnly = false) => async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Access denied. No token provided." });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password -otpToken +tokenVersion").populate("roleId", "name permissions");
    if (!user) {
      return res.status(401).json({ message: "Invalid token. User not found." });
    }
    if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ message: "Session has been revoked. Please login again." });
    }
    if (decoded.sid) {
      const session = await Session.findOne({ userId: user._id, sessionId: decoded.sid, revokedAt: null, expiresAt: { $gt: new Date() } });
      if (!session) return res.status(401).json({ message: "Session has expired or been revoked." });
      req.sessionId = decoded.sid;
      if (!session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > 60000) {
        Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
      }
    }

    // Pending drivers may edit only the onboarding routes that explicitly opt in.
    // Approved accounts disabled by an administrator never qualify.
    if (!user.isActive && !((allowOnboarding || statusOnly) && user.role === "driver" && (statusOnly || user.isVerified) && user.registrationStatus !== "approved" && !user.deletedAt)) {
      return res.status(403).json({ message: "Account is deactivated. Contact admin." });
    }

    req.user = user;
    next();
  } catch (error) {
    if (['TokenExpiredError','JsonWebTokenError'].includes(error.name)) void require('../services/auditService').log({action:'authentication_failed',targetType:'Session',metadata:{reason:error.name},ipAddress:req.ip});
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired. Please login again." });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token." });
    }
    return res.status(500).json({ message: "Authentication error", error: error.message });
  }
};
const protect = authenticate();
const protectOnboarding = authenticate(true);
const protectOnboardingStatus = authenticate(false, true);

/**
 * RBAC authorization middleware
 * Usage: authorize("user:delete", "admin:access")
 */
const authorize = (...permissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // Only the ownership role bypasses checks. Every other staff role is explicit.
    if (req.user.role === "superadmin") {
      return next();
    }

    // Transitional fallback prevents legacy staff lockout before roleId migration.
    // Once a roleId is assigned, its stored permissions are authoritative.
    const userPermissions = require("../services/reportAccess").effectivePermissions(req.user);

    // Check if user has ALL required permissions (or at least one? Let's go with ALL required for this route, or we can use ANY. Let's do ANY for flexibility or require exact).
    // Usually, you might want to check if user has at least one of the required permissions, or all. Let's check for ALL permissions passed.
    const hasPermission = permissions.every(p => userPermissions.includes(p));

    if (!hasPermission) {
      void require('../services/auditService').log({actorId:req.user._id,actorRole:req.user.role,action:'access_denied',targetType:'Route',metadata:{path:req.originalUrl?.split('?')[0],permissions},ipAddress:req.ip});
      return res.status(403).json({ message: "Forbidden. Insufficient permissions." });
    }

    next();
  };
};

module.exports = {
  protect,
  protectOnboarding,
  protectOnboardingStatus,
  authorize,
};
