const test = require("node:test"),
  assert = require("node:assert/strict"),
  duration = require("../services/rideDuration");
const now = Date.parse("2026-10-05T10:10:00Z");
test("real start time and confirmation fallback produce finite elapsed minutes", () => {
  assert.equal(duration({ startedAt: "2026-10-05T10:00:00Z" }, now), 10);
  assert.equal(
    duration(
      { startedAt: "invalid", startConfirmedAt: "2026-10-05T10:05:00Z" },
      now,
    ),
    5,
  );
});
test("missing, invalid and future starts remain unknown without blocking ride completion", () => {
  for (const startedAt of [undefined, null, "", "invalid", "2027-01-01"])
    assert.equal(duration({ startedAt }, now), undefined);
  assert.equal(duration({ actualDurationMin: NaN }, now), undefined);
  assert.equal(duration({ actualDurationMin: 8 }, now), 8);
});
test("legacy ride can confirm destination without a start timestamp and retry safely", async () => {
  const fs = require("node:fs"),
    vm = require("node:vm"),
    path = require("node:path"),
    Ride = require("../models/Ride");
  const ride = new Ride({
    rideStatus: "stop_requested",
    paymentMethod: "cash",
    passengerId: "507f1f77bcf86cd799439011",
    driverId: "507f1f77bcf86cd799439012",
  });
  let saves = 0;
  ride.save = async () => {
    const error = ride.validateSync();
    if (error) throw error;
    saves++;
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../services/rideEngineService.js"),
      "utf8",
    ),
    {
      module,
      require: (key) =>
        key === "./rideDuration"
          ? duration
          : key === "../models/Ride"
            ? { findOne: async () => ride }
            : {},
      Date,
      console,
    },
  );
  const first = await module.exports.confirmStop(ride.passengerId, ride._id);
  assert.equal(first.rideStatus, "awaiting_payment");
  assert.equal(first.actualDurationMin, undefined);
  assert.equal(saves, 1);
  await module.exports.confirmStop(ride.passengerId, ride._id);
  assert.equal(saves, 1);
});
