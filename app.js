const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const mongoose = require("mongoose");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");
const financialWriteGuard = require("./middleware/financialWriteGuard");

// Load environment variables
dotenv.config();

const app = express();


// ─── Middleware ──────────────────────────────────────────
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
const normalizeOrigin = (value) => {
  try { return new URL(value.trim()).origin; } catch { return ""; }
};
const allowedOrigins = new Set([
  "https://mota-admin-web-app.vercel.app",
  ...(process.env.CORS_ALLOWED_ORIGINS || "").split(/[\n,]/),
].map(normalizeOrigin).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(normalizeOrigin(origin))) return callback(null, true);
    console.warn(`[CORS] Rejected origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  optionsSuccessStatus: 204,
}));
app.use(express.json({
  limit: "1mb",
  verify(req, _res, buffer) {
    // Paypack signs the exact bytes it sends. Keep them only for the webhook
    // verifier; JSON parsing alone cannot reproduce the signed byte stream.
    if (req.originalUrl?.startsWith("/api/payment/webhook")) req.rawBody = Buffer.from(buffer);
  },
}));
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));
app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 120, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.AUTH_RATE_LIMIT_PER_15_MIN) || 30, standardHeaders: "draft-8", legacyHeaders: false }));

// ─── Swagger Documentation ─────────────────────────────
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "MOTA API Documentation",
    swaggerOptions: {
      persistAuthorization: true,
    },
  })
);

app.get("/api-docs/swagger.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

// ─── Route Imports ──────────────────────────────────────
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const roleRoutes = require("./routes/roleRoutes");
const adminRoutes = require("./routes/adminRoutes");
const settingRoutes = require("./routes/settingRoutes");
const searchRoutes = require("./routes/searchRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const driverRoutes = require("./routes/driverRoutes");
const rideRoutes = require("./routes/rideRoutes");
const mapRoutes = require("./routes/mapRoutes");

const agentRoutes = require("./routes/agentRoutes");
const ussdRoutes = require("./routes/ussdRoutes");
const walletRoutes = require("./routes/walletRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const systemSettingRoutes = require("./routes/systemSettingRoutes");
const loanRoutes = require("./routes/loanRoutes");
const lookupRoutes = require("./routes/lookupRoutes");
const transferRoutes = require("./routes/transferRoutes");
const fineRequestRoutes = require("./routes/fineRequestRoutes");
const algorithmRoutes = require("./routes/algorithmRoutes");
const platformRoutes = require("./routes/platformRoutes");
const financeRoutes = require("./routes/financeRoutes");
const rideEngineRoutes = require("./routes/rideEngineRoutes");
const realtimeRoutes = require("./routes/realtimeRoutes");
const fuelVoucherRoutes = require("./routes/fuelVoucherRoutes");
const kycRoutes = require("./routes/kycRoutes");
const driverFinanceRoutes = require("./routes/driverFinanceRoutes");
const productionRoutes = require("./routes/productionRoutes");

// ─── API Routes ─────────────────────────────────────────
// (Auth moved to new module below)
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/settings", settingRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/ride", rideRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/ussd", ussdRoutes);
// Wallet cash-in/out uses idempotency keys, MongoDB transactions, held funds,
// and webhook settlement. Other financial modules remain behind the release gate.
app.use("/api/wallet", walletRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/system-settings", systemSettingRoutes);
app.use("/api/loans", financialWriteGuard, loanRoutes);
app.use("/api/lookup", lookupRoutes);
app.use("/api/transfer", financialWriteGuard, transferRoutes);
app.use("/api/fine-requests", fineRequestRoutes);
app.use("/api/ride", algorithmRoutes);  // POST /api/ride/complete
app.use("/api/rider", algorithmRoutes); // GET /api/rider/status, /api/rider/earnings
app.use("/api/platform", platformRoutes);
app.use("/api/finance", financialWriteGuard, financeRoutes);
app.use("/api/rides", rideEngineRoutes);
app.use("/api/maps", mapRoutes);
app.use("/api/realtime", realtimeRoutes);
app.use("/api/fuel-vouchers", fuelVoucherRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/driver-finance", driverFinanceRoutes);
app.use("/api/production", productionRoutes);
app.use("/api/reports", require("./routes/reportRoutes"));
app.use("/api/support", require("./routes/supportRoutes"));
app.use("/api/referrals", require("./routes/referralRoutes"));
// Plain audit log listing (the Audit page uses /api/reports/records/security with redaction).
app.get("/api/audit-logs", require("./middleware/authMiddleware").protect, require("./middleware/authMiddleware").authorize("audit:view"), async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = await require("./services/reportService").records("security", req.query, require("./services/accessService").effectivePermissions(req.user));
    res.json({ data: rows.rows, total: rows.total, page, pages: rows.pages });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load audit logs" }); }
});
const shareRoutes = require("./routes/shareRoutes");
app.use("/api/share", shareRoutes.api);
app.use("/share", shareRoutes.page);

// ─── Root Endpoint ──────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    message: "Welcome to MOTA API v1.0",
    description: "Digital platform for moto-taxi drivers in Kigali, Rwanda",
    documentation: "/api-docs",
    endpoints: {
      auth: "/api/auth",
      driver: "/api/driver",
      ride: "/api/ride",
      admin: "/api/admin",
      agent: "/api/agent",
      wallet: "/api/wallet",
      payment: "/api/payment",
      ussd: "/api/ussd",
      uploads: "/api/uploads",
      notifications: "/api/notifications",
      users: "/api/users",
      roles: "/api/roles",
      settings: "/api/settings",
      search: "/api/search",
      systemSettings: "/api/system-settings",
      loans: "/api/loans",
      lookup: "/api/lookup",
      transfer: "/api/transfer",
      fineRequests: "/api/fine-requests",
      rider: "/api/rider",
      platform: "/api/platform",
      finance: "/api/finance",
      rideEngine: "/api/rides",
    },
  });
});

// ─── 404 Handler ────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.url} not found` });
});

// ─── Global Error Handler ───────────────────────────────
app.use((err, req, res, next) => {
  // Handle JSON parsing errors
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      message: "Invalid JSON in request body",
      error: err.message,
    });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal server error" });
});

module.exports = app;
