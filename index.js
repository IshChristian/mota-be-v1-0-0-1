// Process entry point: connects the database, starts background jobs and the
// HTTP + WebSocket server. The Express app itself lives in app.js (tests import it).
const http = require("http");
const dotenv = require("dotenv");
dotenv.config();
const mongoose = require("mongoose");
const connectDB = require("./config/database");
const { seedDefaults } = require("./services/systemSettingService");
const { startScheduler } = require("./utils/scheduler");
const { initCron } = require("./services/cronService");
const { initSocket } = require("./services/socketService");
const app = require("./app");

const server = http.createServer(app);
// Initialize WebSockets
initSocket(server);
// SSE streams are long-lived; don't let Node's request timeout cut them.
server.requestTimeout = 0;

// ─── Database Connection ────────────────────────────────
connectDB().then(async () => {
  try {
    await seedDefaults();
    // Start MOTA Algorithm Engine scheduler
    startScheduler();
    // Initialize Daily Tasks Cron (Fuel vouchers etc)
    initCron();
    // Says in the logs which email routes this server can reach.
    require("./services/emailService").checkEmail().then((results) => {
      for (const r of results) console.log(`Email route ${r.route}: ${r.ok ? "ready" : `unavailable (${r.error})`}`);
    }).catch((error) => console.error("Email check failed:", error.message));
  } catch (err) {
    console.error("Failed to seed defaults:", err.message);
  }
});

// ─── Start Server ───────────────────────────────────────
const port = process.env.PORT || 5000;
server.listen(port, () => {
  console.log(`\n🚀 MOTA API Server running on port ${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api-docs`);
  console.log(`🔗 API Base URL: http://localhost:${port}/api`);
  console.log(`🔌 WebSocket server is active\n`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down gracefully`);
  server.close(async () => {
    try { await mongoose.connection.close(); }
    finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
