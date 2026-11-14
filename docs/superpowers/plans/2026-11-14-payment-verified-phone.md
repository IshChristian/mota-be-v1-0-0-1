# Phone Proven by Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the SMS code from sign-up. A phone becomes proven (`isVerified`) when a mobile-money payment from that exact number succeeds. Users can type the number for payments and withdrawals, and withdrawals need the account password.

**Architecture:** One helper, `markPhoneProvenByPayment`, is called wherever a Paypack collection settles. Driver and sign-up gates stop reading `isVerified`; loans and referrals keep reading it. The app stops routing to the code screens and gains number and password fields.

**Tech Stack:** Express 5 / Mongoose (CommonJS), node:test + supertest (`tests/harness.js`, throwaway mongod); Expo Router app.

**Spec:** `docs/superpowers/specs/2026-11-14-payment-verified-phone-design.md`

## Global Constraints

- Backend work lives in worktree `/home/ishimchristian/mota-be-payverify`, branch `claude/payment-verified-phone-20261114`. App work goes on `Mota-Digital` `claude/mota-backend-integration`.
- **Phone equality:** two numbers are equal when `normalizeRwPhone(a) === normalizeRwPhone(b)` (`services/smsService.js`). This means `0788…`, `788…`, `250788…` and `+250788…` all match.
- **Gates that stay on `isVerified`:** `services/lendingPolicyService.js` and `services/referralService.js`.
- **Driver checks that stay:** `kycLevel === "full"`, `registrationPaid`, `registrationStatus === "approved"`, `isActive`, not `activationBlocked`, not deleted.
- **Withdrawal errors:**
  - wrong or missing password → 401 `"Incorrect password."`;
  - account with no password → 409 `"Set a password in your account first."`;
  - after 5 failed password attempts per user in 15 min → 429.
- **Exact copy:**
  - Withdrawal alert, shown when the destination isn't the registered number: `Withdrawal of {amount} RWF to {phone} requested.`
  - Loans hint: `Your number is confirmed automatically after your first mobile money payment from it.`
- **Stuck-passenger cutoff:** `createdAt >= 2026-03-18T00:00:00Z`.
- New app copy must be added in en/fr/rw/sw.

## Review Focus

- Paypack redelivers a successful webhook, or the status-poll path settles the same payment. `isVerified` stays true, and referral settlement must not double-pay. Test it in Task 2.
- A passenger pays a ride from a typed number that isn't theirs. The ride is paid, but the passenger stays unverified. Test it in Task 2.
- An admin edits a user's phone **and** sets `isVerified: true` in the same request. The admin's explicit value wins, so staff can verify manually. Test it in Task 3.
- An old app version still calls `verify-otp` after registering. It must keep working, and it sets `isVerified` as before. Test it in Task 1.
- A withdrawal is retried with the same Idempotency-Key after a wrong-password 401. Nothing is created, so a correct retry creates exactly one withdrawal. Test it in Task 4.

---

### Task 1: Sign-up and driver gates without the phone code

**Files:**
- Modify:
  - `controllers/authController.js`: `register`, `payRegistration` (≈432), `submitRegistration` (≈485);
  - `middleware/authMiddleware.js:42-46`;
  - `services/driverOnlineEligibility.js:15-16`;
  - `services/rideEngineService.js` (≈894, automatic go-online filter).
- Test:
  - `tests/payment-verified-phone.test.js` (new);
  - update any existing tests that assert "Verify your phone" (grep for them).

**Interfaces:**
- Produces: `POST /api/auth/register` → 201 `{ message, userId, token, user, payment }`, where `user` has the same fields as the `/login` response `user`. A Session row is created, as in `login`.
  - Passengers (`client`): `isActive: true`, `isVerified: false`.
  - Drivers: as today (`isActive: false`).
  - No OTP is generated and no registration SMS is sent. The referral SMS stays.

- [ ] **Step 1: Write failing tests** in `tests/payment-verified-phone.test.js`. Use `startStack`, and `supertest` against `app`.
  - `register returns a session and the passenger can use it`: POST register as client. Assert 201, `token`, `user.isActive === true`, `user.isVerified === false`. Then `GET /api/users/me` with the bearer token returns 200.
  - `register sends no SMS`: `SmsLog.countDocuments({ phone: <+250 form> })` is 0. `PINDO_API_TOKEN` is empty in the harness, so any attempt would log a failed row.
  - `old app: verify-otp still verifies`: register, set `otpToken = generateOTPToken(id, "123456")` directly, POST verify-otp, then assert `isVerified`.
  - `unverified driver with full KYC, paid fee and approval can go online`: use `makeDriver()` from `tests/fixtures.js`, set `isVerified: false`, then call `assertDriverCanGoOnline` (`services/driverOnlineEligibility.js`); it must not throw. Also check the automatic go-online path through the route the existing tests use (grep `availability` in tests/).
  - `driver can pay registration without a verified phone`: unverified driver with submitted DriverKyc. `POST /api/auth/pay-registration` must not return 409 "Verify your phone".
- [ ] **Step 2: Run** `node --test tests/payment-verified-phone.test.js`. Expected: the new tests FAIL; verify-otp passes (it's a guard).
- [ ] **Step 3: Implement.**
  - In register: drop the OTP and SMS, and return the session. Extract `createLoginSession(user, req)` from `login`, and have both call it.
  - Remove the `isVerified` conditions from:
    - authMiddleware (both lines; the 403 message order becomes registration fee → KYC);
    - `payRegistration` (keep the KYC submitted/approved check, and change the message to `"Submit driver KYC before payment."`);
    - `submitRegistration`;
    - `assertDriverCanGoOnline`;
    - the `rideEngineService` go-online filter.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass, after fixing tests that asserted the removed phone gate (ledger each one).
- [ ] **Step 5: Commit** `feat: sign up without a phone code; drivers no longer need a verified phone`.

### Task 2: A successful payment from the registered number proves the phone

**Files:**
- Create: `services/phoneProofService.js`.
- Modify:
  - `models/User.js` (add `registrationPayerPhone: String`);
  - `controllers/authController.js` (`payRegistration` accepts `phone`);
  - `services/rideEngineService.js` (`requestRidePayment`);
  - `controllers/rideEngineController.js:112`;
  - `controllers/paymentController.js` (`handleWebhook`: the registration branch ≈127, the cash-in branch ≈149, the ride-payment branch ≈177).
- Test: `tests/payment-verified-phone.test.js`.

**Interfaces:**
- Produces:
  - `samePhone(a: string, b: string): boolean`.
  - `markPhoneProvenByPayment(userId, payerPhone: string): Promise<boolean>`. It returns true only when it flipped `isVerified` false→true. It uses an atomic `findOneAndUpdate({_id, isVerified: false}, {isVerified: true})` after the phone check, then runs `referralService.trySettleReferral(userId)` only when it flipped.
  - `requestRidePayment(passengerId, rideId, payerPhone?: string)`:
    - the controller passes `req.body.phone`;
    - an invalid number → 400 `"Enter a valid Rwanda phone number."`;
    - Paypack is charged at `payerPhone || passenger.phone`;
    - the Transaction gets `senderPhone: <charged number>`.
  - `payRegistration` takes body `phone?`, validated the same way and defaulting to `user.phone`. It stores `registrationPayerPhone` and charges that number.
- Webhook wiring:

| Branch | Who is the user | Payer phone |
|---|---|---|
| Registration success | the user with `registrationPaypackRef` | `user.registrationPayerPhone \|\| user.phone` |
| Wallet cash-in, after `settleCashInTransaction` credits | `tx.driverId` | `tx.senderPhone` |
| Ride payment | `(await Ride.findById(tx.rideId)).passengerId` | `tx.senderPhone` |

  - In each branch, `markPhoneProvenByPayment` runs only on `"successful"`.
  - The status-poll path calls `handleWebhook`, so it's covered automatically.

- [ ] **Step 1: Write failing tests.** Mock Paypack by stubbing `paymentService.requestCashIn`, as `tests/cashout.test.js` / `rider-features.test.js` do (grep `requestCashIn` in tests and reuse that stub). Post webhooks to `/api/payment/webhook` the way existing tests do (grep `payment/webhook` in tests for the signature/rawBody helper).
  - `cash-in from the registered number verifies`: wallet cash-in with `phone` = registered number in `07…` form while the user is stored as `+250…`, then a successful webhook. Assert `isVerified === true`.
  - `cash-in from another number does not verify`.
  - `ride paid from the passenger's number verifies the passenger`.
  - `ride paid from a typed other number does not verify the passenger`: also assert the Paypack stub was called with that typed number.
  - `registration fee from the registered number verifies; from another number it does not`: two drivers. Also assert the stub was called with the typed number.
  - `redelivered success does not settle referrals twice`: wrap or spy `referralService.trySettleReferral` by replacing the module export before requiring the controller, and assert it's called once for two identical webhooks.
- [ ] **Step 2: Run** `node --test tests/payment-verified-phone.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the service and the wiring above.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: a successful payment from the registered number proves the phone`.

### Task 3: Phone changes reset proof; stuck-passenger script

**Files:**
- Modify: `controllers/adminController.js` (`updateUserAccount` ≈138), `controllers/userController.js` (`verifyContactChange` ≈171).
- Create: `scripts/activateUnverifiedPassengers.js`, with the logic in `services/stuckPassengerService.js` so tests can call it.
- Test: `tests/payment-verified-phone.test.js`.

**Interfaces:**
- Produces:
  - `findStuckPassengers(): Promise<User[]>` and `activateStuckPassengers({ dryRun: boolean }): Promise<{ matched: number, activated: number }>`.
  - CLI: `node scripts/activateUnverifiedPassengers.js [--apply]`. The default is a dry run that prints `matched N`; `--apply` prints `activated N`.
  - Filter:
    - `role: "client"`, `isVerified: false`, `isActive: false`;
    - `deletedAt: null`, `activationBlocked: { $ne: true }`;
    - `createdAt >= 2026-03-18T00:00:00Z`;
    - excluding ids that have an `AuditLog` row with `action: "user_updated"`, `targetId: id`, and `metadata.changes.isActive` existing.
- Rules:
  - Admin update: when `updates.phone` is present and `!samePhone(updates.phone, before.phone)` and `updates.isVerified === undefined`, set `updates.isVerified = false`.
  - Contact change: when the phone changes, set `isVerified = false`. The spec requires this.

- [ ] **Step 1: Write failing tests:**
  - `admin phone edit resets verification`;
  - `admin phone edit with explicit isVerified true keeps it`;
  - `admin edit that re-sends the same phone in another format keeps verification`;
  - `contact change to a new phone resets verification`: set `pendingPhone` and `contactChangeOtpHash` directly, then call verify;
  - `stuck-passenger script activates only the intended accounts`: seed 6 clients:
    - stuck, should activate;
    - created 2026-03-01 (before the cutoff);
    - verified;
    - `activationBlocked`;
    - deleted;
    - has the admin `isActive` audit row.
    Assert that the dry run reports `matched 1` and changes nothing, and that apply activates exactly the stuck one.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: phone changes reset proof; script to let stuck passengers in`.

### Task 4: Withdraw to a typed number with the account password

**Files:**
- Modify:
  - `controllers/walletController.js` (`requestCashOut` ≈133);
  - `routes/walletRoutes.js:256` (limiter on `/cash-out`; update the swagger body to `amount, phone, password`).
- Test: `tests/payment-verified-phone.test.js` (or extend `tests/cashout.test.js` if its helpers make it simpler).

**Interfaces:**
- Produces: `POST /api/wallet/cash-out` with body `{ amount, phone, password }`.
  1. Check the idempotency header, as today.
  2. Load the user with `+password`. No password → 409.
  3. `bcrypt.compare` fails → 401.
  4. An invalid phone → 400 `"Enter a valid Rwanda phone number."`.
  5. `requestWithdrawal({ ..., phone: normalized typed phone })`.
  6. When `!samePhone(phone, user.phone)`, create an in-app notification for the user with the exact alert copy. Use the existing `notificationService` the handler already requires; grep its create/notify function.
- Limiter: `express-rate-limit`, `windowMs` 15 min, `limit` 5, `keyGenerator: (req) => req.user.id`, `skipSuccessfulRequests: true`, `skipFailedRequests: false`. It counts only responses with status ≥ 400, which are failed attempts. It must sit after authentication on that route; check how `walletRoutes` applies `protect`.

- [ ] **Step 1: Write failing tests:**
  - `withdrawal with wrong password is 401 and creates nothing`;
  - `withdrawal to a typed number pays that number`: assert the `WithdrawalRequest.phone` and the payout stub's number;
  - `withdrawal to another number alerts the owner`: notification exists with the exact copy;
  - `withdrawal to own number sends no alert`;
  - `passwordless account gets 409`;
  - `sixth wrong password within 15 min is 429`;
  - `same idempotency key: wrong password then correct creates exactly one withdrawal`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: withdraw to a typed number with the account password`.

### Task 5: App — no code step, number and password fields

**Files:**
- Modify:
  - `app/(auth)/register.tsx`: on success with `token` and `user`, call `login(token, user)` from `useAuth`; the root layout routes from there. Recovery path: on `recovery.data.userId`, go to login.
  - `app/_layout.tsx`: delete the `needsPhoneVerification` redirect, and remove `user.isVerified !== true` from `needsDriverReview`.
  - `app/(auth)/verification-progress.tsx:36`: remove the "Phone number" step.
  - `app/(driver)/wallet.tsx`: the withdraw modal gets a `RwandaPhoneInput` pre-filled with `user.phone` and a password field (`secureTextEntry`). Send `{ amount, phone: normalizeRwandaPhone(phone), password }`. Show the server message on 401, 409 and 429.
  - `services/api.ts`: `cashOut` data type becomes `{ amount: number; phone: string; password: string }`.
  - `components/passenger/ride/TripPanel.tsx:134`: before paying, show a `RwandaPhoneInput` pre-filled with the passenger's phone, and call `ridesApi.payRide(ride._id, normalizeRwandaPhone(phone))`. `payRide` already sends `phone`.
  - `app/(auth)/payment-registration.tsx`: replace the read-only number with an editable `RwandaPhoneInput`, defaulting to `displayPhone`, and send it.
  - `app/loans.tsx`: when the loan request is refused for an unverified phone (check what `lendingPolicyService` returns), show the loans hint copy.
  - `i18n/{en,fr,rw,sw}.ts`.

- [ ] **Step 1: Add i18n keys first and run** `node --test tests/i18n-coverage.test.cjs`. Expected: FAIL until all 4 languages are filled, then PASS. Keys:
  - `wallet.withdraw_to` ("Send to this number");
  - `wallet.password_confirm` ("Your MOTA password");
  - `trip.pay_from` ("Pay from this MoMo number");
  - `registration.pay_from` ("Pay the fee from this MoMo number");
  - `loans.phone_unproven` (the loans hint copy).
- [ ] **Step 2: Implement** the file changes above.
- [ ] **Step 3: Check:** `npx tsc --noEmit -p .` shows 0 errors, and `node --test tests/` passes.
- [ ] **Step 4: Browser check** (`CI=1 EXPO_PUBLIC_API_BASE_URL=http://localhost:5099/api npx expo start --web`, against the local backend from this branch) with the scratchpad puppeteer:
  - register a passenger and land on the passenger home, with no code screen;
  - register a driver and land on verification-progress, with no phone step;
  - the driver wallet withdraw form shows the number and password fields, and a wrong password shows "Incorrect password.".
- [ ] **Step 5: Commit** (app repo) `Sign up without a phone code; choose the number for payments and withdrawals`.
