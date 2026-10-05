const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
function setup() {
  const calls = [],
    module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../services/driverSessionAvailability.js"),
      "utf8",
    ),
    {
      module,
      require: () => ({
        findByIdAndUpdate: async (id, update) => calls.push({ id, update }),
      }),
    },
  );
  return { calls, ...module.exports };
}
test("completed driver login clears saved manual offline", async () => {
  const h = setup(),
    user = { _id: "driver", role: "driver", availabilityManuallyOffline: true };
  await h.beginDriverSession(user);
  assert.equal(user.availabilityManuallyOffline, false);
  assert.equal(h.calls[0].update.$set.availabilityManuallyOffline, false);
});
test("passenger login does not alter availability", async () => {
  const h = setup();
  await h.beginDriverSession({ _id: "passenger", role: "passenger" });
  assert.equal(h.calls.length, 0);
});
test("driver logout atomically revokes token and goes offline", async () => {
  const h = setup();
  await h.revokeSessionAndAvailability({ id: "driver", role: "driver" });
  assert.equal(h.calls[0].update.$inc.tokenVersion, 1);
  assert.equal(h.calls[0].update.$set.isOnline, false);
  assert.equal(h.calls[0].update.$set.availabilityManuallyOffline, true);
});
test("passenger logout revokes credentials without driver fields", async () => {
  const h = setup();
  await h.revokeSessionAndAvailability({ id: "passenger", role: "passenger" });
  assert.equal(h.calls[0].update.$inc.tokenVersion, 1);
  assert.equal(h.calls[0].update.$set, undefined);
});
function availability(options = {}) {
  const module = { exports: {} },
    calls = [],
    driver = {
      role: "driver",
      isOnline: true,
      save: async () => calls.push("save"),
    };
  const dates = Object.fromEntries(
    [
      "drivingLicenseExpiresAt",
      "transportPermitExpiresAt",
      "insuranceExpiresAt",
      "vehicleRegistrationExpiresAt",
      "technicalInspectionExpiresAt",
    ].map((key) => [key, new Date(Date.now() + 86400000)]),
  );
  const source = fs.readFileSync(
    path.join(__dirname, "../services/rideEngineService.js"),
    "utf8",
  );
  const service = source.slice(
    source.indexOf("const setDriverAvailability ="),
    source.indexOf("// ═", source.indexOf("const setDriverAvailability =")),
  );
  vm.runInNewContext(service + "\nmodule.exports=setDriverAvailability", {
    module,
    User: {
      findById: async () => driver,
      findOneAndUpdate: async (filter, update) => {
        calls.push({ filter, update });
        return options.concurrentOffline ? null : driver;
      },
    },
    DriverKyc: { findOne: async () => dates },
    Ride: { findOne: async () => null },
    Date,
  });
  return { calls, driver, set: module.exports };
}
test("manual offline preference is persisted with availability", async () => {
  const h = availability();
  const result = await h.set("driver", false);
  assert.equal(result.isOnline, false);
  assert.equal(h.driver.availabilityManuallyOffline, true);
});
test("manual online clears the offline preference", async () => {
  const h = availability();
  const result = await h.set("driver", true);
  assert.equal(result.isOnline, true);
  assert.equal(h.driver.availabilityManuallyOffline, false);
});
test("automatic online cannot override manual offline or a revoked session", async () => {
  const h = availability({ concurrentOffline: true });
  const result = await h.set("driver", true, true, 3);
  assert.equal(result.isOnline, false);
  const { filter } = h.calls[0];
  assert.equal(filter.availabilityManuallyOffline.$ne, true);
  assert.equal(filter.tokenVersion, 3);
  assert.equal(filter.kycLevel, "full");
  assert.equal(filter.isActive, true);
  assert.equal(filter.activationBlocked.$ne, true);
  assert.equal(filter.deletedAt, null);
  assert.ok(!h.calls.includes("save"));
});
test("automatic online supports legacy token version zero", async () => {
  const h = availability();
  assert.equal((await h.set("driver", true, true, 0)).isOnline, true);
  const { filter } = h.calls[0];
  assert.equal(filter.$or[0].tokenVersion, 0);
  assert.equal(filter.$or[1].tokenVersion.$exists, false);
});
