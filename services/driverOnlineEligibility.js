const documentDates = [
  ["drivingLicenseExpiresAt", "Driving licence"],
  ["transportPermitExpiresAt", "Transport permit"],
  ["insuranceExpiresAt", "Vehicle insurance"],
  ["vehicleRegistrationExpiresAt", "Vehicle registration"],
  ["technicalInspectionExpiresAt", "Technical inspection"],
];

function assertDriverCanGoOnline(driver, kyc, now = Date.now()) {
  if (driver.role !== "driver") throw new Error("Only drivers can go online.");
  if (driver.kycLevel !== "full")
    throw new Error("Complete KYC verification before going online.");
  if (!driver.isActive || driver.activationBlocked || driver.deletedAt)
    throw new Error("Your driver account is disabled. Contact MOTA support.");
  if (!driver.isVerified)
    throw new Error("Verify your phone before going online.");
  if (!driver.registrationPaid)
    throw new Error("Complete your registration fee before going online.");
  // Full KYC is the canonical admin-approved account status. Legacy verified
  // accounts may predate DriverKyc and its expiry fields. Do not revoke that
  // verification merely because their newer document metadata is absent.
  for (const [key, label] of documentDates) {
    const value = kyc?.[key];
    if (value === undefined || value === null || value === "") continue;
    const expiry = new Date(value).getTime();
    if (!Number.isFinite(expiry))
      throw new Error(
        `${label} has an invalid expiry date. Update it in your verification documents before going online.`,
      );
    if (expiry <= now)
      throw new Error(
        `${label} has expired. Renew it in your verification documents before going online.`,
      );
  }
}
module.exports = { assertDriverCanGoOnline };
