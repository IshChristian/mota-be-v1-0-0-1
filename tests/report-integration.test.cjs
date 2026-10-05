const test = require("node:test"),
  assert = require("node:assert/strict");
const uri = process.env.REPORT_TEST_MONGO_URI;
test(
  "real Mongo reporting, HTTP permissions, immediate revocation and auditable exports",
  { skip: !uri, timeout: 120000 },
  async () => {
    assert.match(
      uri,
      /\/mota_reporting_test(?:\?|$)/,
      "Use an isolated test database only.",
    );
    const mongoose = require("mongoose");
    await mongoose.connect(uri);
    process.env.JWT_SECRET = "reporting-integration-test-only";
    const models = Object.fromEntries(
      [
        "User",
        "Role",
        "Ride",
        "Transaction",
        "Wallet",
        "WithdrawalRequest",
        "Referral",
        "SupportCase",
        "AuditLog",
        "Upload",
        "SafetyEvent",
        "RideDispute",
      ].map((n) => [n, require("../models/" + n)]),
    );
    const reports = require("../services/reportService"),
      jwt = require("jsonwebtoken"),
      express = require("express");
    let server;
    try {
      await mongoose.connection.dropDatabase();
      const owner = await models.User.create({
        firstName: "Test",
        lastName: "Owner",
        phone: "test-owner",
        role: "superadmin",
        isActive: true,
      });
      const analyst = await models.User.create({
        firstName: "Test",
        lastName: "Analyst",
        phone: "test-analyst",
        role: "agent",
        isActive: true,
        reportPermissions: [
          "analytics:view",
          "analytics:users",
          "analytics:export",
        ],
      });
      const driver = await models.User.create({
        firstName: "Test",
        lastName: "Driver",
        phone: "test-driver",
        role: "driver",
        isActive: true,
        isVerified: true,
        kycLevel: "full",
        registrationPaid: true,
      });
      const now = new Date();
      const id = driver._id;
      await models.Ride.collection.insertMany(
        Array.from({ length: 6 }, () => ({
          driverId: id,
          passengerId: analyst._id,
          rideStatus: "completed",
          paymentStatus: "successful",
          driverEarning: 900,
          fare: 1000,
          createdAt: now,
          acceptedAt: now,
          pickup: { latitude: -1.95, longitude: 30.05 },
        })),
      );
      await models.Transaction.create({
        driverId: id,
        type: "cash_in",
        status: "successful",
        amount: 5000,
      });
      await models.Wallet.create({ driverId: id, balance: 5000 });
      await models.WithdrawalRequest.create({
        driverId: id,
        amount: 1000,
        fee: 100,
        totalHeld: 1100,
        phone: "test-driver",
        idempotencyKey: "test-1",
      });
      await models.Referral.create({
        referrerId: id,
        referredUserId: analyst._id,
        status: "successful",
        reward: 500,
      });
      await models.SupportCase.collection.insertOne({
        customerId: analyst._id,
        category: "general",
        status: "open",
        createdAt: now,
        updatedAt: now,
      });
      await models.Upload.create({
        userId: id,
        url: "https://example.test/private",
        publicId: "test",
        format: "pdf",
        size: 100,
      });
      await models.SafetyEvent.create({ reporterId: id, type: "sos" });
      await models.RideDispute.create({
        rideId: (await models.Ride.findOne())._id,
        openedBy: analyst._id,
        category: "fare",
        description: "Test dispute description",
      });
      await models.AuditLog.create({
        actorId: owner._id,
        actorRole: "superadmin",
        action: "user_updated",
        targetType: "User",
        targetId: id,
        metadata: {
          before: { phone: "private", password: "hidden" },
          after: { isActive: true },
        },
      });
      const summary = await reports.summary(owner, {});
      assert.equal(Object.keys(summary.sections).length, 11);
      assert.equal(summary.sections.users.cards["New accounts"], 3);
      assert.equal(summary.sections.rides.cards.Completed, 6);
      assert.equal(summary.sections.demand.cells.length, 1);
      assert.equal(
        summary.sections.finance.cards["Wallet available now (RWF)"],
        5000,
      );
      assert.equal(summary.sections.support.cards["Safety events"], 1);
      for (const section of Object.keys(reports.sections)) {
        const rows = await reports.records(owner, section, {});
        assert.ok(Array.isArray(rows.rows), section);
      }
      const masked = await reports.records(
        {
          ...owner.toObject(),
          role: "admin",
          reportPermissions: ["audit:view"],
        },
        "security",
        {},
      );
      assert.equal(masked.rows[0].metadata.before.phone, "[restricted]");
      assert.equal(masked.rows[0].metadata.before.password, "[redacted]");
      const app = express();
      app.use(express.json());
      app.use("/api/reports", require("../routes/reportRoutes"));
      server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const base = "http://127.0.0.1:" + server.address().port + "/api/reports";
      const call = (path, user, options = {}) =>
        fetch(base + path, {
          ...options,
          headers: {
            Authorization:
              "Bearer " +
              jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET),
            "Content-Type": "application/json",
          },
        });
      assert.equal((await fetch(base + "/summary")).status, 401);
      assert.equal(
        (await call("/summary?section=finance", analyst)).status,
        403,
      );
      assert.equal((await call("/export/finance/xlsx", analyst)).status, 403);
      const exported = await call("/export/users/xlsx", analyst);
      assert.equal(exported.status, 200);
      assert.ok((await exported.arrayBuffer()).byteLength > 1000);
      assert.equal(
        await models.AuditLog.countDocuments({ action: "report_exported" }),
        1,
      );
      const grant = await call("/access/users/" + analyst._id, owner, {
        method: "PUT",
        body: JSON.stringify({ permissions: [] }),
      });
      assert.equal(grant.status, 200);
      assert.equal(
        await models.AuditLog.countDocuments({
          action: "report_access_updated",
        }),
        1,
      );
      assert.equal((await call("/summary?section=users", analyst)).status, 403);
      assert.equal(
        (
          await call("/access/users/" + owner._id, owner, {
            method: "PUT",
            body: JSON.stringify({ permissions: [] }),
          })
        ).status,
        400,
      );
    } finally {
      if (server) await new Promise((r) => server.close(r));
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
