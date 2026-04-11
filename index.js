const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");
const connectDB = require("./config/database");
const { seedDefaults } = require("./services/systemSettingService");
const { startScheduler } = require("./utils/scheduler");

// Load environment variables
dotenv.config();

const app = express();

// ─── Middleware ──────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// ─── Database Connection ────────────────────────────────
connectDB().then(async () => {
  try {
    await seedDefaults();
    // Start MOTA Algorithm Engine scheduler
    startScheduler();
  } catch (err) {
    console.error("Failed to seed defaults:", err.message);
  }
});

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
app.use("/api/wallet", walletRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/system-settings", systemSettingRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/lookup", lookupRoutes);
app.use("/api/transfer", transferRoutes);
app.use("/api/fine-requests", fineRequestRoutes);
app.use("/api/ride", algorithmRoutes);  // POST /api/ride/complete
app.use("/api/rider", algorithmRoutes); // GET /api/rider/status, /api/rider/earnings
app.use("/api/platform", platformRoutes);

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

// ─── Start Server ───────────────────────────────────────
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`\n🚀 MOTA API Server running on port ${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api-docs`);
  console.log(`🔗 API Base URL: http://localhost:${port}/api\n`);
});