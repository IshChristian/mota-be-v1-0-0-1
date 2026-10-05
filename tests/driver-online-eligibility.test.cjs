const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  assertDriverCanGoOnline,
} = require("../services/driverOnlineEligibility");
const driver = {
  role: "driver",
  kycLevel: "full",
  isActive: true,
  isVerified: true,
  registrationPaid: true,
};
test("full KYC driver without a legacy document record can go online", () =>
  assert.doesNotThrow(() => assertDriverCanGoOnline(driver, null)));
test("full KYC driver with missing historical expiry fields can go online", () =>
  assert.doesNotThrow(() =>
    assertDriverCanGoOnline(driver, { status: "approved" }),
  ));
test("account full KYC is canonical even when older document review status differs", () =>
  assert.doesNotThrow(() =>
    assertDriverCanGoOnline(driver, { status: "pending" }),
  ));
test("approved document metadata alone does not grant full account KYC", () =>
  assert.throws(
    () =>
      assertDriverCanGoOnline(
        { ...driver, kycLevel: "basic" },
        { status: "approved" },
      ),
    /Complete KYC/,
  ));
for (const [key, label] of [
  ["drivingLicenseExpiresAt", "Driving licence"],
  ["transportPermitExpiresAt", "Transport permit"],
  ["insuranceExpiresAt", "Vehicle insurance"],
  ["vehicleRegistrationExpiresAt", "Vehicle registration"],
  ["technicalInspectionExpiresAt", "Technical inspection"],
])
  test("expired " + label + " is named clearly", () =>
    assert.throws(
      () => assertDriverCanGoOnline(driver, { [key]: new Date(1000) }, 2000),
      new RegExp(label + " has expired"),
    ),
  );
test("invalid stored dates are rejected instead of silently ignored", () =>
  assert.throws(
    () => assertDriverCanGoOnline(driver, { insuranceExpiresAt: "bad-date" }),
    /invalid expiry/,
  ));
test("expiry at the current time is expired", () =>
  assert.throws(
    () =>
      assertDriverCanGoOnline(
        driver,
        { insuranceExpiresAt: new Date(2000) },
        2000,
      ),
    /expired/,
  ));
test("valid expiry is accepted and optional DVC does not block availability", () =>
  assert.doesNotThrow(() =>
    assertDriverCanGoOnline(
      driver,
      {
        insuranceExpiresAt: new Date(3000),
        vocationalCardExpiresAt: new Date(1000),
      },
      2000,
    ),
  ));
for (const [change, expected] of [
  [{ role: "passenger" }, /Only drivers/],
  [{ isActive: false }, /disabled/],
  [{ activationBlocked: true }, /disabled/],
  [{ deletedAt: new Date() }, /disabled/],
  [{ isVerified: false }, /phone/],
  [{ registrationPaid: false }, /registration fee/],
])
  test("full KYC preserves guard " + JSON.stringify(change), () =>
    assert.throws(
      () => assertDriverCanGoOnline({ ...driver, ...change }, null),
      expected,
    ),
  );
