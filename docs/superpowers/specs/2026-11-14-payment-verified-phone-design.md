# Phone proven by payment, not by SMS code

Date: 2026-11-14 · Status: draft for owner approval (builder check done)
Repos: backend `mota-be-v1-0-0-1` (branch `claude/payment-verified-phone-20261114`), app `Mota-Digital` (branch `claude/mota-backend-integration`)

## Why

Every SMS since 2026-03-18 has failed (Pindo has no approved sender ID), and sign-up requires an SMS code. As a result, passengers who registered since March cannot log in, and drivers cannot reach KYC or payment. The owner wants verification that costs nothing. The decision is to drop the code at sign-up and treat a phone as proven once a **mobile money payment from that number succeeds**: the owner approved it with their MoMo PIN, which is proof of ownership.

## Decisions made by the owner (2026-11-14)

1. **No phone code at sign-up.** People register and use the app immediately.
2. **Approach: reuse the existing `isVerified` flag.** A successful MoMo payment from the account's registered number sets `isVerified = true`. Places that already require `isVerified` keep working unchanged: drivers going online, loans, referral rewards, and admin "phone verified" counts.
3. **Withdrawals can go to any number the user types, but the user must re-enter their account password every time** (owner chose this over "only numbers that have paid in"). The owner accepted the residual risk: someone who knows the password can withdraw to their own number.
4. **Number taken by someone else:** when the real owner of a number finds it already used by another account, **support resolves it manually** by editing the phone in the admin panel, which already exists. Nothing new is built for this.
5. Deposits, ride MoMo payments and withdrawals let the user **type the number** to use, pre-filled with their registered number.
6. **Drivers don't need a proven number to work.** The registration fee can be paid from any number (the fee screen gets a number field). A driver goes online once KYC is complete, the fee is paid and an admin has approved them; the admin's national-ID check is the identity proof for drivers. A proven number is still required for **loans and referral rewards**, for drivers and passengers alike.

## Approaches considered

1. **Reuse `isVerified`, set by payment (chosen).** One change point, existing gates and reports keep their meaning.
2. A new "proven by payment" flag with every gate switched to it. Rejected: two flags meaning nearly the same thing, more code touched, no gain.
3. No phone proof anywhere. Rejected: loans and referral rewards would be open to fake numbers.

## Goals

- A new passenger registers and is logged in, with no code screen.
- A new driver registers and goes straight to KYC, then pays the registration fee from any number they choose. If that number is their registered one, the payment also proves the phone.
- `isVerified` becomes true the first time any MoMo payment *from the registered number* succeeds: wallet deposit, ride paid by MoMo, or driver registration fee.
- Users already stuck (unverified, never able to log in) get in without doing anything.
- Withdrawals: the user enters the destination number and their password. A wrong password means nothing is sent.
- Drivers can complete onboarding and go online without a proven number.

## Non-goals

- WhatsApp verification (PR #52) is left open and unmerged. Whether to keep it as an optional "verify now" is a later decision.
- No automatic way for the real owner to claim a number (support handles it).
- No change to email verification, 2FA, or password reset.
- No new SMS sending. Existing SMS calls stay as they are and start working again if Pindo is fixed.

## Anti-goals

- A payment from a **different** number must never mark the account's registered number as proven.
- A withdrawal must never be sent without a correct password check in the same request.
- Loans and referral rewards must never become available to an account whose number was never proven.
- Removing the phone check for drivers must not remove any other driver check: KYC, registration fee and admin approval all stay.

## Design

### Backend

**Registration (`authController.register`)**
- Stop generating the phone OTP and stop sending the "Welcome to MOTA! Your code" SMS.
- Passengers (`client`) are created `isActive: true`, `isVerified: false`.
- Drivers are created as today (`isActive: false`, onboarding).
- The response also returns a login session (`token` + `user`), shaped like the `/login` response and created the same way (Session row, driver session handling), so the app can go straight in.
- The `verify-otp` and `resend-otp` endpoints stay and still work, for app versions already installed.

**Login (`authController.login`)**
- The "Verify your phone to continue" 403 no longer applies to passengers. Passengers are active from registration.
- The 403 remains only for accounts that are really disabled (`isActive: false` set by an admin, `activationBlocked`, deleted).

**Driver onboarding and going online (decision 6)**
- Remove the `isVerified` requirement from:
  - `payRegistration`;
  - `submitRegistration` (≈480);
  - `authMiddleware` (≈42 and the inactive-driver onboarding branch at ≈45);
  - `driverOnlineEligibility` (≈15);
  - the go-online update in `rideEngineService` (≈894).
- Every other driver condition stays: `kycLevel` full, `registrationPaid`, `registrationStatus` approved, not blocked or deleted.
- `payRegistration` accepts an optional `phone` (Rwandan, normalized, defaults to `user.phone`). The fee is collected from it, and the charged number is stored on the user (`registrationPayerPhone`). When registration payment succeeds, `markPhoneProvenByPayment(user, registrationPayerPhone)` runs, so the phone is proven only when it was the registered number.
- The registration-fee request made inside `register` for agents is unchanged.

**Marking the phone proven: one helper, `markPhoneProvenByPayment(userId, payerPhone)`**
- Sets `isVerified = true` only when `normalizeRwPhone(payerPhone) === normalizeRwPhone(user.phone)`. The comparison must also tolerate `07…` vs `+2507…` vs `2507…`.
- It is idempotent. It also runs referral settlement (`trySettleReferral`), as `verifyOTP` does today.
- It is called from every place that marks a Paypack collection successful:
  - the payment webhook in `paymentController`: wallet cash-in (`settleCashInTransaction`), ride and other cash-in transactions, and registration fee (`registrationPaypackRef`);
  - the status-poll path in `paymentController` that settles a transaction from Paypack's status API.
- **Payer phone:**
  - For transactions, it is `tx.senderPhone`. The cash-in already stores it.
  - For registration fees, the backend currently collects from `user.phone`. The builder must store which number was charged, or rely on that.
- For drivers, `tx.driverId` is the user. For passenger ride payments, the user is the passenger on the ride. The builder confirms which field holds the payer's user id for each transaction type.
- If Paystack is the active provider, the same helper is called where Paystack settles a collection.

**Ride MoMo payment (passenger)**
- `rideEngineService` (≈ line 630) charges `passenger.phone`.
- Change: accept an optional `payerPhone` from the passenger's payment request, validated as a Rwandan number and defaulting to `passenger.phone`. Store it as the transaction's `senderPhone`.

**Withdrawals (`walletController.requestCashOut` → `withdrawalService.requestWithdrawal`)**
- The request body gains `phone` (required, Rwandan number, normalized) and `password` (required).
- `bcrypt.compare` is checked against the user's password before anything else.
  - Wrong or missing password → 401, nothing created.
  - An account with no password (e.g. Google sign-in) → 409 "Set a password in your account first". This is my call: there's nothing to re-enter otherwise.
- Wrong-password attempts are rate-limited per user: **5 per 15 min**, then 429. This is my call, to stop password guessing from a stolen session.
- The withdrawal is created with the typed phone. Everything downstream (Paypack payout, `manual_required` fallback, staff alerts) already takes the phone from the request.
- After a withdrawal to a number **different** from the registered phone, the account owner gets an in-app notification: "Withdrawal of X RWF to 078… requested." This is my call, a cheap alarm for a stolen password.
- The idempotency-key behaviour is unchanged. A replayed request must still not send twice.

**Phone number changes reset the proof** (my call; it follows from the anti-goals)
- When a user's `phone` changes, `isVerified` becomes false in the same write. This covers the admin edit (`adminController` update via `editableUserFields`) and the user's own contact change (`userController`, which today sets `isVerified = true` after an SMS code).
- The new number is proven by its own first payment, like any other.
- The admin panel's phone edit is how support resolves taken numbers (decision 4).
- The contact-change flow still depends on an SMS code, which is broken. Fixing that is out of scope here.

**Fix for people already stuck (one-off script, `scripts/activateUnverifiedPassengers.js`)** (filter is my call)
- Targets `client` accounts that meet all of these:
  - `isVerified: false`;
  - `isActive: false`;
  - not deleted, not `activationBlocked`;
  - `createdAt >= 2026-03-18` (when SMS broke);
  - **no** `AuditLog` `user_updated` entry for that user whose `metadata.changes` includes `isActive`. That entry would mean an admin switched them off on purpose.
- Sets `isActive: true` and leaves `isVerified` false.
- It has a dry-run mode that only prints counts, and it prints how many accounts it changed. Run once after deploy.

**`isVerified` checks that stay:** `lendingPolicyService` (loans) and `referralService` (referral rewards). The admin reports also still count `isVerified`.

### App (Mota-Digital)

**Register screen**
- After a successful register, store the returned session and go into the app.
  - Passengers land on home.
  - Drivers enter onboarding (KYC).
- No navigation to `confirm-phone` / `otp`.
- The "registration recovery" path (`recovery.data.isVerified` → confirm-phone) also stops sending people to the code screen.

**Login**
- The "Verify your phone" branch stays for old accounts that still get that 403, but new and fixed accounts never hit it.

**Number entry**
- `RwandaPhoneInput` with the same validation and normalization as the existing driver deposit.
- Pre-filled with the registered number.
  - Driver wallet withdraw: a new number field plus a password field.
  - Passenger MoMo ride payment: a number field where the passenger chooses MoMo.
  - Driver registration-fee screen: a number field.
- Driver deposit already has a number field. It stays.

**Status hint**
- Where a feature is blocked for an unproven number (loans), show: "Your number is confirmed automatically after your first mobile money payment from it."

**Copy**
- New copy is added in en/fr/rw/sw; the i18n parity test enforces this.

## Left to the builder

- Exact field holding the payer's user id per transaction type.
- Whether to record the charged number on registration-fee payments, or rely on `user.phone`.
- The name and placement of the per-user wrong-password limiter.
- Where exactly the ride-payment number field sits in the passenger ride flow.
- Tests. At minimum:
  - register returns a session and the passenger can call an authed route;
  - payment from the registered number sets `isVerified`, and from another number it does not;
  - registration-fee success from the registered number sets `isVerified`, and from another number it does not;
  - a driver with an unverified phone but full KYC, fee paid and admin approval can go online;
  - an admin phone edit resets `isVerified`;
  - the webhook replayed twice stays idempotent;
  - withdrawal with a wrong password is 401 and creates nothing;
  - withdrawal to a typed number pays that number;
  - a passwordless account gets 409;
  - the 6th wrong password within 15 min gets 429;
  - the migration script activates only the intended accounts;
  - the loan gate still refuses an unverified account.
