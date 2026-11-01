# Mobile ride and fuel service repairs

Deploy this backend together with the mobile PR on `codex/mobile-upload-fuel-rides-20261005`.

## Ride completion

Both destination confirmation and legacy completion use a finite duration helper. Valid `startedAt` or `startConfirmedAt` gives elapsed minutes. If neither exists, duration remains unknown; arrival confirmation no longer tries to save `NaN`. Existing ownership, lifecycle and payment checks remain in force. Assigned riders receive the driver's plate from DriverProfile, with no identity documents exposed.

## Fuel process

- Active drivers retain the existing policy: 1,000 RWF per request, up to two requests per type per Kigali calendar day.
- Clients send an `Idempotency-Key` (16–100 alphanumeric/underscore/hyphen characters). Retries with the same key recover the original voucher. Quota checks and allocation occur in one conditional MongoDB update.
- QR vouchers are active until Kigali midnight. Responses contain the actual code and a PNG QR data URI. `GET /api/fuel-vouchers/:id` supplies the owner's current voucher details.
- MoMo requests remain pending. This change does not initiate a MoMo transfer or implement an approval/payout integration; the UI must never describe pending as a payment.
- Only staff with `fuel_voucher:manage` can redeem. `POST /api/fuel-vouchers/redeem-code` accepts `{ "code": "MOTA-QR-…" }` from an attendant's scanned/copied code. `PATCH /api/fuel-vouchers/:userId/:id/redeem` supports ID-based staff review. Both record a redemption audit event. Driver self-redemption is denied. An expired, pending or already-used voucher cannot be redeemed.
- Configure the `fuel_stations` system setting as an array of `{id,name,address,acceptsQr,active}`. Empty means no confirmed partners; there is no invented station list. A partner/staff interface still needs to call the protected redemption endpoint.
- Savings count only confirmed redemptions during the previous seven days, using redemption time.

## Verification

Node tests cover legacy Ride schema validation, retry recovery, Kigali dates, idempotent/conditional fuel allocation, QR generation, redemption, expiry, savings and HTTP redemption permissions. Fuel database calls use a model test double; live MongoDB concurrency and partner redemption still require staging verification. No production vouchers or payouts were created.

## Full KYC activation and welcome account snapshot

A pending driver with `kycLevel: full` is promoted to active/approved when KYC is reviewed, an admin updates the account, the driver signs in or an authenticated account check runs. This is an idempotent conditional update. It does not reactivate deleted accounts, accounts explicitly disabled through user management (`activationBlocked`), or approved accounts that have been suspended.

Phone verification and the 5,000 RWF driver fee remain separate requirements for operational APIs. An active driver who still owes the fee can inspect account status and continue onboarding, but cannot use operational APIs until verified and paid. Payment confirmation preserves existing approval and returns actual activation state.

`GET /api/users/me` now returns a safe account snapshot, actual driver profile existence and an `onboarding` summary from the KYC record. This enables welcome and Continue to use current server data. Passwords, OTPs, reset tokens and 2FA secrets are excluded. Inactive accounts may read their own status, but cannot access normal protected operations.
