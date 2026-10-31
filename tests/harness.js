// Integration-test harness: a throwaway single-node MongoDB replica set
// (wallet code uses transactions) and the Express app from app.js.
// Requires `mongod` on PATH. Runs from a temp directory so dotenv can never
// load the real .env (production database, SMS and payment keys).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const ROOT = path.resolve(__dirname, "..");
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mota-cwd-"));
process.chdir(tmpCwd);
Object.assign(process.env, {
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    PUBLIC_BASE_URL: "https://mota.test",
    PINDO_API_TOKEN: "",
    PAYPACK_CLIENT_ID: "test-client-id", // the SDK refuses empty keys at load; tests never call Paypack
    PAYPACK_CLIENT_SECRET: "test-client-secret",
    SMTP_USER: "",
    SMTP_PASS: "",
    GOOGLE_MAPS_API_KEY: "",
    GOOGLE_ROUTES_API_KEY: "",
    OSRM_URL: "", // no network routing in tests
    API_RATE_LIMIT_PER_MINUTE: "100000",
    AUTH_RATE_LIMIT_PER_15_MIN: "100000",
});

const mongoose = require(path.join(ROOT, "node_modules/mongoose"));
const freePort = () => new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

let mongod, dbPath;

async function startStack() {
    const port = await freePort();
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "mota-db-"));
    mongod = spawn("mongod", ["--replSet", "rs0", "--port", String(port), "--dbpath", dbPath, "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    const base = `mongodb://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try {
            const c = await mongoose.createConnection(`${base}/admin?directConnection=true`, { serverSelectionTimeoutMS: 300 }).asPromise();
            await c.db.admin().command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } }).catch(() => {});
            for (let j = 0; j < 100 && !(await c.db.admin().command({ hello: 1 })).isWritablePrimary; j++) await new Promise((r) => setTimeout(r, 100));
            await c.close();
            break;
        } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    process.env.MONGO_URI = `${base}/mota_test?directConnection=true&replicaSet=rs0`;
    await mongoose.connect(process.env.MONGO_URI);
    const app = require(path.join(ROOT, "app.js"));
    await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => {})));
    return app;
}

async function stopStack() {
    await mongoose.disconnect();
    mongod?.kill("SIGTERM");
    await new Promise((r) => (mongod ? mongod.once("exit", r) : r()));
    fs.rmSync(dbPath, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
}

const clearDb = () => Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));

module.exports = { startStack, stopStack, clearDb, ROOT };
