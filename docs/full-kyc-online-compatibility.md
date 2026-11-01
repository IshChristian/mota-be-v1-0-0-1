# Full KYC availability compatibility

Going online previously demanded both account kycLevel=full (through authentication) and a separate DriverKyc status=approved row with all five expiry fields populated (through availability). These fields were historically optional. Consequently, an older/admin-verified full-KYC account could be rejected even though account verification was complete.

Account kycLevel=full is now the canonical verification requirement. The availability endpoint does not require duplicate document approval or missing historical expiry metadata. New KYC submission still requires its existing complete documents and valid expiry dates; no missing values are fabricated. Existing stored expiry dates are checked, and an expired or invalid date names the document that must be corrected.

Phone verification, registration fee, active/non-suspended account, saved manual-offline preference, logout revocation and automatic-request token-version checks remain enforced. Optional DVC is not a new availability gate. Deploy this backend change; no mobile update is necessary for this correction.

Regression coverage includes a full driver with no historical KYC record, missing date fields, manual and automatic availability, each expired required document, invalid dates, basic KYC, suspended/disabled/deleted accounts, phone and registration-fee requirements. Controlled model tests verify the existing persistence path. Real affected-account verification requires an authenticated deployed session.
