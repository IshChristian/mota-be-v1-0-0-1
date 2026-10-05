const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path"),
  mongoose = require("mongoose");
function setup(options = {}) {
  const user = {
      _id: "user",
      role: options.role || "driver",
      isActive: true,
      fuelVouchers: options.vouchers || [],
    },
    updates = [];
  user.fuelVouchers.id = (id) =>
    user.fuelVouchers.find((v) => String(v._id) === String(id));
  const User = {
    findById: async () => {
      const snapshot = {
        ...user,
        fuelVouchers: user.fuelVouchers.map((v) => ({ ...v })),
      };
      snapshot.fuelVouchers.id = (id) =>
        snapshot.fuelVouchers.find((v) => String(v._id) === String(id));
      return snapshot;
    },
    findOne: (filter) => ({
      select: async () =>
        user.fuelVouchers.some((v) => v.code === filter["fuelVouchers.code"])
          ? user
          : null,
    }),
    findOneAndUpdate: async (filter, update) => {
      updates.push({ filter, update });
      if (update.$push) {
        const v = update.$push.fuelVouchers;
        const condition = filter.$expr.$lt[0].$size.$filter.cond.$and;
        const same = user.fuelVouchers.filter(
          (row) =>
            row.type === v.type &&
            +new Date(row.issuedAt) >= +condition[1].$gte[1] &&
            +new Date(row.issuedAt) <= +condition[2].$lte[1],
        );
        if (
          user.fuelVouchers.some(
            (row) => row.idempotencyKey === v.idempotencyKey,
          ) ||
          same.length >= 2
        )
          return null;
        user.fuelVouchers.push(v);
        return user;
      }
      const v = user.fuelVouchers.id(filter.fuelVouchers.$elemMatch._id);
      if (
        !v ||
        v.status !== "active" ||
        +v.expiresAt < +filter.fuelVouchers.$elemMatch.expiresAt.$gte
      )
        return null;
      v.status = "redeemed";
      v.redeemedAt = update.$set["fuelVouchers.$.redeemedAt"];
      v.isUsed = true;
      return user;
    },
  };
  const module = { exports: {} },
    deps = {
      crypto: require("crypto"),
      qrcode: require("qrcode"),
      mongoose: mongoose,
      "../models/User": User,
      "./configService": { getConfig: async () => options.stations || [] },
    };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../services/fuelVoucherService.js"),
      "utf8",
    ),
    { module, require: (name) => deps[name], Date, console },
  );
  return { service: module.exports, user, updates };
}
test("daily window follows Kigali midnight rather than server timezone", () => {
  const { from, to } = setup().service.dayWindow(
    new Date("2026-10-05T22:30:00Z"),
  );
  assert.equal(from.toISOString(), "2026-10-05T22:00:00.000Z");
  assert.equal(to.toISOString(), "2026-10-06T21:59:59.999Z");
});
test("QR request returns real QR image and replay does not allocate twice", async () => {
  const { service, user, updates } = setup();
  const first = await service.claim("user", "qr", "request_0000000001"),
    again = await service.claim("user", "qr", "request_0000000001");
  assert.equal(String(first.id), String(again.id));
  assert.match(first.qrImage, /^data:image\/png;base64,/);
  assert.equal(user.fuelVouchers.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].filter.isActive, true);
});
test("concurrent duplicate requests recover the same voucher", async () => {
  const { service, user } = setup();
  const rows = await Promise.all(
    Array.from({ length: 5 }, () =>
      service.claim("user", "momo", "request_0000000001"),
    ),
  );
  assert.equal(new Set(rows.map((row) => String(row.id))).size, 1);
  assert.equal(user.fuelVouchers.length, 1);
  assert.equal(rows[0].status, "pending");
});
test("atomic allocation limits distinct concurrent requests to two per type", async () => {
  const { service, user } = setup();
  const rows = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      service.claim("user", "momo", `request_000000000${i}`),
    ),
  );
  assert.equal(rows.filter((row) => row.status === "fulfilled").length, 2);
  assert.equal(user.fuelVouchers.length, 2);
  for (const row of rows.filter((row) => row.status === "rejected"))
    assert.equal(row.reason.statusCode, 409);
});
test("invalid type, request key and passenger role rejected", async () => {
  const { service } = setup();
  await assert.rejects(
    service.claim("user", "other", "request_0000000001"),
    /MoMo or QR/,
  );
  await assert.rejects(service.claim("user", "qr", "bad"), /request key/);
  await assert.rejects(
    setup({ role: "client" }).service.claim("user", "qr", "request_0000000001"),
    (error) => error.statusCode === 403,
  );
});
test("expired vouchers are displayed expired and cannot be redeemed", async () => {
  const v = {
    _id: new mongoose.Types.ObjectId(),
    status: "active",
    type: "qr",
    expiresAt: new Date(Date.now() - 1000),
  };
  const { service } = setup({ vouchers: [v] });
  assert.equal(service.statusOf(v), "expired");
  await assert.rejects(
    service.redeem("user", String(v._id)),
    (error) => error.statusCode === 409,
  );
});
test("redemption cannot be repeated and pending requests are not redeemable", async () => {
  const { service } = setup();
  const v = await service.claim("user", "qr", "request_0000000001");
  assert.equal((await service.redeem("user", String(v.id))).status, "redeemed");
  await assert.rejects(
    service.redeem("user", String(v.id)),
    (error) => error.statusCode === 409,
  );
  const pending = await service.claim("user", "momo", "request_0000000002");
  await assert.rejects(
    service.redeem("user", String(pending.id)),
    (error) => error.statusCode === 409,
  );
});
test("savings count redemption within seven days, not issue date or pending amount", async () => {
  const now = Date.now(),
    rows = [
      {
        type: "qr",
        status: "redeemed",
        amount: 1000,
        issuedAt: new Date(now - 20 * 86400000),
        redeemedAt: new Date(now - 1000),
      },
      {
        type: "momo",
        status: "pending",
        amount: 99999,
        redeemedAt: new Date(now),
      },
      {
        type: "qr",
        status: "redeemed",
        amount: 500,
        redeemedAt: new Date(now - 8 * 86400000),
      },
    ];
  assert.equal(
    (await setup({ vouchers: rows }).service.weeklySavings("user")).weekTotal,
    1000,
  );
});
test("partner directory excludes inactive entries without invented stations", async () => {
  assert.equal((await setup().service.stations()).length, 0);
  const rows = await setup({
    stations: [
      { name: "Approved", address: "Kigali", acceptsQr: true },
      { name: "Inactive", active: false },
    ],
  }).service.stations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Approved");
});

test("staff can redeem a scanned code without exposing an owner ID in the QR", async () => {
  const { service } = setup();
  const row = await service.claim("user", "qr", "request_0000000001");
  assert.equal((await service.redeemCode(row.code)).voucher.status, "redeemed");
  await assert.rejects(
    service.redeemCode(row.code),
    (e) => e.statusCode === 409,
  );
  await assert.rejects(service.redeemCode("invalid"), /valid MOTA/);
});
test("redemption routes deny drivers, passengers and staff without permission", async () => {
  const express = require("express"),
    app = express(),
    module = { exports: {} },
    auth = require("../middleware/authMiddleware"),
    audit = require("../services/auditService"),
    originalLog = audit.log;
  audit.log = async () => {};
  let redeemed = 0;
  const controller = {};
  for (const name of [
    "claimMoMo",
    "claimQR",
    "dailyStatus",
    "history",
    "weeklySavings",
    "stations",
    "details",
    "redeem",
    "redeemCode",
  ])
    controller[name] = (req, res) => {
      redeemed++;
      res.json({ data: { status: "redeemed" } });
    };
  const dependencies = {
    express,
    "../controllers/fuelVoucherController": controller,
    "../middleware/authMiddleware": {
      protect: (req, res, next) => {
        req.user = {
          id: "user",
          role: req.headers["x-role"],
          reportPermissions: [],
          roleId: {
            permissions:
              req.headers["x-grant"] === "yes" ? ["fuel_voucher:manage"] : [],
          },
        };
        next();
      },
      authorize: auth.authorize,
    },
    "../constants/staffRoles": require("../constants/staffRoles"),
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../routes/fuelVoucherRoutes.js"),
      "utf8",
    ),
    { module, require: (name) => dependencies[name] },
  );
  app.use(express.json(), module.exports);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = `http://127.0.0.1:${server.address().port}`;
    for (const role of ["driver", "client", "admin"]) {
      const r = await fetch(address + "/redeem-code", {
        method: "POST",
        headers: {
          "x-role": role,
          "x-grant": role === "admin" ? "no" : "yes",
          "Content-Type": "application/json",
        },
        body: '{"code":"MOTA-QR-000000000001"}',
      });
      assert.equal(r.status, 403);
    }
    const accepted = await fetch(address + "/redeem-code", {
      method: "POST",
      headers: {
        "x-role": "agent",
        "x-grant": "yes",
        "Content-Type": "application/json",
      },
      body: '{"code":"MOTA-QR-000000000001"}',
    });
    assert.equal(accepted.status, 200);
    assert.equal(redeemed, 1);
    const old = await fetch(address + "/voucher/redeem", {
      method: "PATCH",
      headers: { "x-role": "driver", "x-grant": "yes" },
    });
    assert.equal(old.status, 403);
  } finally {
    audit.log = originalLog;
    await new Promise((resolve) => server.close(resolve));
  }
});
