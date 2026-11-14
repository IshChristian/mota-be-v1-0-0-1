# Fee Promo Rules and Passenger Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two changes:
- Driver fee promo codes always leave something to pay, and show the discount as a percentage behind a "Verify" button.
- Passengers must confirm their email and submit their ID before they can request a ride.

**Architecture:**
- Fee rule: in `promoService.reserve`/`quote`, for `registration_fee` the discount is capped at `amount − 100`. The fee's free promo path is removed. Preview adds `percent`.
- Passenger rule: a gate in `rideEngineService.requestRide` returns 403 `{ code: "VERIFY_TO_RIDE", needs }`. Register requires email for `client`.
- The app shows a "Verify to ride" card.

**Tech Stack:** Express/Mongoose with node:test; the Expo app; the Vite admin panel.

**Spec:** Short design approved in conversation on 2026-11-14 (passenger option A). This file records it:
- **Fee:** stays at the configured fee (5,000 default) and is never free.
  - A fee code's discount is capped so the driver pays at least **100 RWF**.
  - The fee screen shows "{percent}% off · you pay {payAmount} RWF" with the Pay button.
  - The button reads **Verify**.
- **Passengers:**
  - Email is required at sign-up (`role: client`).
  - Requesting a ride (including a scheduled one) needs `isEmailVerified === true` **and** a PassengerKyc with status `submitted`, `approved` or `correction`. Staff review afterwards.
  - Existing passengers follow the same rule at their next booking.
  - Drivers are unchanged.

## Global Constraints

- Backend Task 1 goes on `claude/promo-codes-20261114` (PR #54).
- Backend Task 2 goes on a new branch `claude/passenger-verification-20261114` from Task 1's head, in worktree `/home/ishimchristian/mota-be-promo`.
- App work goes on `claude/mota-backend-integration`; admin work on `claude/promo-codes-20261114`.
- **Exact copy:**
  - 403 message: `"Confirm your email and submit your ID before booking a ride."`
  - Sign-up message: `"Email is required for passengers."`
  - App chip: `{{percent}}% off · you pay {{payAmount}} RWF`
- `needs` is `{ email: boolean, identity: boolean }`, where true means that step is still missing.

## Review Focus

- **A scheduled ride request** goes through the same `requestRide` and is gated too. Test it in Task 2.
- **A passenger whose ID was sent back for correction** is still allowed, because they submitted. Test it in Task 2.
- **A fee code with a fixed value above the fee** still leaves 100 RWF to pay. Test it in Task 1.
- **The admin's own preview** of a 100% fee code shows "pays 100 RWF", not 0. Covered in Task 4 (form example).
- **A driver's ride request** is not affected by the passenger gate. Test it in Task 2.

---

### Task 1: Fee codes always leave ≥100 RWF; preview percent (backend, PR #54)

**Files:** `services/promoService.js`, `controllers/promoController.js`, `controllers/authController.js` (`payRegistration` free-promo path), `tests/promo-codes.test.js`

**Interfaces:**
- Produces:
  - `discountFor(promo, amount)` is unchanged.
  - The new `effectiveDiscount(promo, amount)` = `discountFor` capped at `max(0, amount − 100)` when `promo.appliesTo === "registration_fee"`. `quote` and `reserve` use it.
  - Preview `data` gains `percent: Math.round(discount / originalAmount * 100)`.

- [ ] **Step 1: Failing tests.**
  - Replace `100% fee code makes registration free immediately` with `100% fee code still leaves 100 RWF to pay`: the stub is charged 100, and the fee isn't paid until the webhook.
  - Add `fixed fee code above the fee leaves 100 RWF`.
  - Add `preview returns the discount percentage`: a 20% ride code gives `percent: 20`; a fixed 500 off 2000 gives 25.
- [ ] **Step 2: Run** `node --test tests/promo-codes.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fee promo codes always leave 100 RWF to pay; preview shows percent`.

### Task 2: Passengers verify email and ID before booking (backend, new branch)

**Files:** `controllers/authController.js` (`register`), `services/rideEngineService.js` (`requestRide`), `controllers/rideEngineController.js` (map the error), `tests/passenger-verification.test.js`

**Interfaces:**
- Produces:
  - `assertPassengerVerified(passengerId)`, which throws `Object.assign(new Error(MSG), { status: 403, code: "VERIFY_TO_RIDE", needs })`.
  - The controller returns 403 `{ code, message, needs }`.
  - Register returns 400 `"Email is required for passengers."` when `role` is client and there is no email.

- [ ] **Step 1: Failing tests:**
  - `passenger sign-up needs an email`;
  - `unverified passenger can't request a ride`: `needs` is `{ email: true, identity: true }`;
  - `email confirmed but no ID: needs identity`;
  - `email confirmed and ID submitted can request`;
  - `ID in correction still allowed`;
  - `scheduled request is gated too`;
  - `driver sign-up without email still works`.
  - Use `tests/fixtures.js` `requestRide(app, passenger, body)` for requests. The existing fixtures make passengers who are verified, so set `isEmailVerified: true` and create a submitted PassengerKyc in `makePassenger` by default, so that existing ride tests keep passing.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS (fixture updated).
- [ ] **Step 5: Commit** `feat: passengers confirm email and submit ID before booking`.

### Task 3: App

**Files:**
- `components/payments/PromoCodeInput.tsx`: "Verify" label, and the chip shows the percentage.
- `services/api.ts`: `PromoPreview.percent`.
- `components/passenger/ride/TripPanel.tsx` and `app/(auth)/payment-registration.tsx`: remount the box (`key`) and clear `promo` when a pay call fails with a `reason` (review fix).
- `app/(auth)/register.tsx`: email required for passengers.
- `app/(passenger)/index.tsx`:
  - load `/kyc` status and `user.isEmailVerified`, and show a "Verify to ride" card with two steps linking to `/(auth)/verify-email` and `/(passenger)/profile/kyc`;
  - a 403 `VERIFY_TO_RIDE` on request shows the card.
- `i18n/*`.

- [ ] **Step 1: Add the i18n keys** in all 4 languages: `promo.verify`; `promo.applied` changed to the percent copy; `verify.title`, `verify.body`, `verify.email`, `verify.identity`, `verify.done`, `auth.email_required`. Run `node --test tests/i18n-coverage.test.cjs`. Expected: PASS.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Check:** `npx tsc --noEmit` shows 0 errors, and `node --test tests/` passes.
- [ ] **Step 4: Browser check** (local stack):
  - the fee code shows "50% off · you pay 2,500 RWF";
  - an unverified passenger sees the card and can't request;
  - after confirming email and submitting the ID, the card is gone.
- [ ] **Step 5: Commit.**

### Task 4: Admin panel

**Files:** `src/utils/localDateTime.ts` and `PromoCodesPage.tsx` (date fix, already written); the form example caps fee codes at "pays 100 RWF" and adds the hint "Drivers always pay at least 100 RWF."

- [ ] **Step 1:** Check that `tsc --noEmit` shows 0 errors and `vite build` succeeds, and that the date round-trip check in Kigali, UTC, New York and Kolkata passes.
- [ ] **Step 2: Commit and push**, together with PR #54, the app branch and the new backend branch (open its PR stacked on #54).
