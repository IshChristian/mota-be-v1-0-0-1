# Promo Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-managed promo codes that discount mobile money and wallet ride payments (for passengers) and the driver registration fee. MOTA pays for the discount.

**Architecture:**
- Two collections hold the data: `PromoCode` and `PromoRedemption`.
- One service, `promoService`, owns all the rules: quote, reserve, redeem and release. The payment code paths call it.
- A use is reserved when a payment starts, redeemed when the payment succeeds, and released when it fails.
- The app only sends the code text. The admin panel manages codes through `/api/admin/promos`.

**Tech Stack:**
- Express 5 / Mongoose (CommonJS) with node:test + supertest (`tests/harness.js`);
- the Expo Router app;
- the Vite/React admin panel (axios, react-router).

**Spec:** `docs/superpowers/specs/2026-11-14-promo-codes-design.md`

## Global Constraints

- **Repos and branches:**
  - backend: worktree `/home/ishimchristian/mota-be-promo`, branch `claude/promo-codes-20261114`;
  - app: `Mota-Digital` `claude/mota-backend-integration`;
  - admin: `/home/ishimchristian/mota-admin-web-app`, new branch `claude/promo-codes-20261114` from `origin/main`.
- **Code text:** `/^[A-Z0-9-]{3,20}$/` after `trim().toUpperCase()`. Codes are unique.
- **Discount:**
  - percent: `round(amount × value / 100)`, capped by `maxDiscount` when it is set;
  - fixed: `value`;
  - never more than `amount`.
- **Refusal messages** (exact; HTTP 400 `{ reason, message }`):

  | reason | message |
  |---|---|
  | `not_found` | "This promo code doesn't exist." |
  | `inactive` | "This promo code is switched off." |
  | `wrong_type` | "This promo code isn't for this payment." |
  | `not_started` | "This promo code isn't active yet." |
  | `expired` | "This promo code has expired." |
  | `below_minimum` | "This promo code needs a payment of at least {minAmount} RWF." |
  | `used_up` | "This promo code has been used up." |
  | `already_used` | "You've already used this promo code." |
  | `drivers_only` | "Promo codes are for driver registration." |

- **Limits:**
  - `maxUsers` counts different people holding a reserved or redeemed use;
  - `perUserLimit` defaults to 1;
  - a person already counted doesn't take a new place.
- **Reservations:**
  - one tied to a Paypack ref lives until that payment fails or succeeds;
  - one with no ref is released after 30 minutes.
- **Under 100 RWF to pay:** no mobile money prompt. The payment is settled at once.
- **Drivers earn on the full fare** when a ride has a code: commission is computed on `ride.fare`, not on the paid amount. Driver-logged and USSD payments, which carry no `promoRedemptionId`, are unchanged.
- **MOTA's cost** is recorded only on the redemption (`subsidy = max(0, discount − commission)` for rides, 0 for fees) and the code (`subsidyTotal`). No Transaction row is added for it, and no finance report is changed.
- **Permissions:**
  - `promo:view` and `promo:manage` go to superadmin and admin;
  - `promo:view` goes to financial.
- **Audit actions:** `promo_created`, `promo_updated`, `promo_deleted`.
- **App copy** must be added in en/fr/rw/sw.

## Review Focus

- **The same Paypack success arrives twice** (webhook plus poll): the code is redeemed once, and the counters move once. Test it in Task 3.
- **A code is applied on a ride paid in cash:** it is refused. `/rides/:id/pay` only serves mobile money. Check that preview with a cash ride gives `wrong_type`. Test it in Task 1.
- **An admin edits a code's value after people used it:** redemptions already made keep their recorded discount, and only new quotes use the new value. Test it in Task 2.
- **A passenger previews, then the code is used up before they pay:** the pay call is refused with `used_up`, and no prompt is sent. Test it in Task 3.
- **A driver applies a fee code and then pays from another number:** both work together. The code is redeemed when the fee is paid, but the phone is not proven (the PR #53 rule still holds). Test it in Task 4.

---

### Task 1: Promo models, rules and preview

**Files:**
- Create:
  - `models/PromoCode.js`
  - `models/PromoRedemption.js`
  - `services/promoService.js`
  - `controllers/promoController.js`
  - `routes/promoRoutes.js` (mounted at `/api/promos`)
- Modify: `app.js` (mount the routes)
- Test: `tests/promo-codes.test.js`

**Interfaces:**
- Produces, from `promoService`:
  - `normalizeCode(code): string`
  - `discountFor(promo, amount): number`
  - `quote({ code, appliesTo, userId, amount }): Promise<{ promo, discount, payAmount, originalAmount }>`
    - It throws `PromoError` (`{ status: 400, reason, message }`, exported).
  - `reserve({ code, appliesTo, userId, amount, rideId?, method }, { session? }): Promise<PromoRedemption>`
  - `attachPaymentRef(redemptionId, ref): Promise<void>`
  - `redeem(redemptionId, { subsidy = 0, session? }): Promise<boolean>`
    - It returns true only on the reserved → redeemed move.
  - `release(redemptionId): Promise<boolean>` and `releaseByPaymentRef(ref): Promise<number>`
  - `releaseStale(now = new Date()): Promise<number>` (30 minutes, no ref only)
  - `statusOf(promo, now): "active"|"scheduled"|"expired"|"used_up"|"off"|"archived"`
- PromoCode fields:
  - `code`, `appliesTo` (`ride` | `registration_fee`), `discountType` (`percent` | `fixed`), `value`;
  - `maxDiscount?`, `minAmount?`, `startsAt?`, `endsAt?`;
  - `maxUsers?`, `perUserLimit` (default 1), `active` (default true), `note?`;
  - `createdBy`, `updatedBy`, `archivedAt?`;
  - counters `usersCount`, `reservedCount`, `redeemedCount`, `totalDiscount`, `subsidyTotal` (all default 0);
  - timestamps.
- PromoRedemption fields:
  - `promoId`, `code`, `userId`, `appliesTo`, `rideId?`, `paymentRef?`;
  - `method` (`momo` | `wallet` | `none`);
  - `originalAmount`, `discount`, `paidAmount`, `subsidy`;
  - `status` (`reserved` | `redeemed` | `released`), `reservedAt`, `redeemedAt?`, `releasedAt?`.
- `POST /api/promos/preview` (signed in, `protectOnboarding` so drivers in onboarding can use it) takes `{ code, appliesTo, rideId? }` and returns 200 `{ data: { code, discount, payAmount, originalAmount } }`.
  - **Ride:** the amount is the fare of the caller's ride. The ride must be `awaiting_payment` with `paymentMethod` `momo` or `wallet`; otherwise it fails with `wrong_type`.
  - **Fee:** the amount is the configured `registration_fee` (default 5000). The caller must be a driver, otherwise `drivers_only`.
- **Concurrency rule for `reserve`:**
  1. Count this user's active (reserved or redeemed) redemptions on the code. If that is at least `perUserLimit`, refuse with `already_used`.
  2. If the user has none, run `findOneAndUpdate({_id, $or:[{maxUsers:null},{$expr:{$lt:["$usersCount","$maxUsers"]}}]}, {$inc:{usersCount:1,reservedCount:1}})`. If nothing matched, refuse with `used_up`.
  3. Otherwise, run `$inc reservedCount`.
  4. Create the redemption.
  - When `release` leaves the user with no active redemption on the code, `$inc usersCount:-1`.

- [ ] **Step 1: Write the failing tests** in `tests/promo-codes.test.js`. Create promos directly through the model, and passengers and drivers with `tests/fixtures.js`.
  - `percent discount with cap`: 20% of 1500 is 300; a cap of 200 gives 200.
  - `fixed discount never above the amount`: 2000 off 1500 is 1500.
  - `each refusal reason`: one assertion per reason, using exact `reason` and `message`; `below_minimum` shows the minimum amount.
  - `preview returns the discounted price`: a ride awaiting MoMo payment with fare 1500 and a 20% code gives `{ discount: 300, payAmount: 1200, originalAmount: 1500 }`.
  - `preview refuses a cash ride`: `wrong_type`.
  - `preview reserves nothing`: the counters are still 0 afterwards.
  - `maxUsers: a third person is refused, an existing person can use remaining uses`: `maxUsers: 2`, `perUserLimit: 2`. Users A and B reserve; C gets `used_up`; A's second reserve succeeds.
  - `last place taken concurrently: only one succeeds`: `maxUsers: 1`; two `reserve` calls through `Promise.all` give exactly one success.
  - `release frees a person's place`.
  - `stale reservation without a ref is released after 30 minutes; one with a ref is kept`: set `reservedAt` 31 minutes ago.
  - `redeem is idempotent`: the second call returns false, and the counters moved once.
- [ ] **Step 2: Run** `node --test tests/promo-codes.test.js`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the models, the service, the preview controller and route, and mount it in `app.js` as `app.use("/api/promos", require("./routes/promoRoutes"))`.
- [ ] **Step 4: Run** `node --test tests/promo-codes.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: promo code rules and preview`.

### Task 2: Admin management API

**Files:**
- Create: `controllers/adminPromoController.js`, `scripts/migratePromoPermissions.js`
- Modify: `routes/adminRoutes.js`, `constants/staffRoles.js` (add `promo:view`, `promo:manage`; financial gets `promo:view`), `models/AuditLog.js` (action enum)
- Test: `tests/promo-codes.test.js`

**Interfaces:**
- Consumes: Task 1's models and `statusOf`.
- Produces:

| Route | Permission | Behaviour |
|---|---|---|
| `GET /api/admin/promos?status=&appliesTo=&q=` | `promo:view` | `{ data: [promo + status] }`. Archived codes are hidden unless `status=archived`. |
| `GET /api/admin/promos/:id?page=` | `promo:view` | `{ data: { promo, status, redemptions, page, pages } }`. 50 per page, newest first, `userId` populated with `firstName lastName phone role`. |
| `POST /api/admin/promos` | `promo:manage` | 201. Validates the code format and the value: percent 1–100, fixed ≥ 1, `perUserLimit` ≥ 1, `maxUsers` ≥ 1 or null, `endsAt` after `startsAt`. A duplicate code gives 409 "That code already exists." |
| `PATCH /api/admin/promos/:id` | `promo:manage` | Same validation. Changing `code` or `appliesTo` after use (`reservedCount + redeemedCount > 0`) gives 409 "Code and type can't change after the code has been used." |
| `DELETE /api/admin/promos/:id` | `promo:manage` | Never used: hard delete, `{ deleted: true }`. Used: sets `archivedAt` and `active: false`, `{ archived: true }`. |

  - Each write logs `promo_created`, `promo_updated` or `promo_deleted` through `auditService.log`, like the other admin writes.
  - `migratePromoPermissions.js` `$addToSet`s the permissions into the stored roles `superadmin`, `admin` (both) and `financial` (`promo:view`). It follows `migrateCashoutAccess.js`.

- [ ] **Step 1: Write the failing tests:**
  - `admin creates, lists and edits a code`;
  - `duplicate code is 409`;
  - `invalid values are 400`;
  - `code text locked after use`;
  - `editing value after use keeps past redemptions' discount`;
  - `deleting an unused code removes it; a used one is archived`;
  - `financial can view but not create`;
  - `a passenger gets 403`;
  - `audit rows are written`.
  - For staff, use `makePassenger({ role: "superadmin" })`. For financial, `makePassenger({ role: "financial" })`; check how `tests/staff-access.test.js` makes role-based staff, and seed roles the same way.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: admin promo code management`.

### Task 3: Codes on ride payments (mobile money and wallet)

**Files:**
- Modify:
  - `services/rideEngineService.js` (`requestRidePayment` ≈624, `confirmStop` ≈547);
  - `controllers/rideEngineController.js` (pass `req.body.promoCode`);
  - `controllers/paymentController.js` (`handleWebhook` ride branch ≈177 and the failed path);
  - `models/Transaction.js` (add `originalAmount: Number`, `promoRedemptionId: ObjectId`).
- Test: `tests/promo-codes.test.js`

**Interfaces:**
- Consumes: Task 1's `reserve`, `attachPaymentRef`, `redeem`, `release`, `releaseByPaymentRef`, `PromoError`.
- Produces:
  - `requestRidePayment(passengerId, rideId, payerPhone?, promoCode?)` and `confirmStop(passengerId, rideId, promoCode?)`.
  - A `PromoError` comes back as HTTP 400 `{ reason, message }`.
- **Mobile money behaviour:**
  1. Reserve on `ride.fare` with `method: "momo"`.
  2. If `payAmount < 100`: settle at once. In one Mongo transaction, credit the driver `driverEarning` from `calculateCommission(ride.fare)`, write the driver's `ride_payment` row and the commission the way the webhook does, set `ride.paymentStatus = "successful"`, and redeem with the subsidy. Return `{ status: "successful", amount: payAmount }`.
  3. Otherwise charge `payAmount`, store the Transaction with `amount: payAmount`, `originalAmount: ride.fare` and `promoRedemptionId`, and attach the ref.
  4. If Paypack refuses to start: release, then throw the existing error.
- **Webhook ride branch:**
  - When `tx.promoRedemptionId` is set, compute commission on `ride.fare`, credit the driver, and redeem with `subsidy = max(0, discount − commission)`. Otherwise it is unchanged.
  - On `failed` for any ref, call `releaseByPaymentRef(ref)`.
- **Paying again:** if `ride.paypackRef` is set and its Transaction is `failed`, clear `ride.paypackRef`, set `paymentStatus` to `pending`, and start fresh.
- **Wallet:** inside the existing `confirmStop` transaction:
  1. reserve (with the session);
  2. debit `payAmount` (balance must be ≥ `payAmount`);
  3. credit the driver from `ride.fare`;
  4. set the passenger Transaction to `amount: -payAmount`, `originalAmount` and `promoRedemptionId`;
  5. redeem with the subsidy, in the same session.
  - An error rolls the whole thing back, so the code isn't used.

- [ ] **Step 1: Write the failing tests.** Stub `paymentService.requestCashIn` and sign Paypack webhooks, as in `tests/payment-verified-phone.test.js`, and set `FINANCIAL_WRITES_ENABLED=true`.
  - `MoMo ride with a code charges the discounted amount and pays the driver on the full fare`: fare 1500, 20% code. The stub is charged 1200. After the webhook, the driver's wallet rises by `driverEarning(1500)`, and the redemption is redeemed with discount 300 and subsidy 150 (at the 10% commission).
  - `failed MoMo payment releases the code`.
  - `failed payment can be retried, with or without a code`.
  - `same success delivered twice redeems once`.
  - `code used up between preview and pay: 400 used_up, no prompt`.
  - `payment under 100 RWF settles without a prompt`: fare 1500, fixed 1450 off; the stub is not called; the ride is paid; the driver is credited.
  - `wallet ride with a code debits the discounted amount`: the wallet goes from 5000 to 3800, the driver is credited on 1500, and the code is redeemed.
  - `wallet with too little balance: error and code not used`.
  - `ride without a code is unchanged`: the existing behaviour still passes.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass, including `tests/ride-commission.test.js` and `tests/payment-verified-phone.test.js`.
- [ ] **Step 5: Commit** `feat: promo codes on MoMo and wallet ride payments`.

### Task 4: Codes on the driver registration fee; stale-release cron

**Files:**
- Modify:
  - `controllers/authController.js` (`payRegistration`, `checkRegistrationPayment`);
  - `routes/authRoutes.js` (the `signedInForOtherPayer` guard also applies when `promoCode` is sent);
  - `models/User.js` (`registrationPromoRedemptionId`);
  - `controllers/paymentController.js` (registration branch: redeem);
  - `services/cronService.js` (call `promoService.releaseStale()` on its existing schedule).
- Test: `tests/promo-codes.test.js`

**Interfaces:**
- Consumes: Task 1's service.
- Produces: `POST /api/auth/pay-registration` accepts `promoCode`.
  - An agent gets `drivers_only`.
  - It quotes against the fee and reserves with `method: "momo"`, or `"none"` when free.
  - If `payAmount < 100`, the existing free path runs (`registrationPaid`, status `pending`) and the code is redeemed.
  - Otherwise it charges `payAmount` and attaches the ref.
  - When the webhook or registration-status marks the fee paid, the code is redeemed with `subsidy: 0`.

- [ ] **Step 1: Write the failing tests:**
  - `fee with a code charges the discounted fee`: 5000 with 20% off charges 4000; after the webhook the code is redeemed and the fee is paid.
  - `fee code needs the driver's session`.
  - `agent gets drivers_only`.
  - `100% fee code makes registration free immediately`.
  - `fee code plus another payer number: fee paid, code redeemed, phone not proven`.
  - `cron releases stale reservations` (call the exported cron step, or `promoService.releaseStale`).
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: promo codes on the driver registration fee`.

### Task 5: App: promo code box on ride payment and fee screens

**Files:**
- Create: `components/payments/PromoCodeInput.tsx`
- Modify:
  - `services/api.ts`: `promoApi.preview({ code, appliesTo, rideId? })`; `ridesApi.payRide(id, phone?, promoCode?)`; `ridesApi.confirmStop(id, promoCode?)`; `payRegistration` data gets `promoCode`.
  - `components/passenger/ride/TripPanel.tsx`: the box sits above "Pay · MoMo" and above "Confirm arrival" when `ride.paymentMethod === "wallet"`. The pay button shows the discounted amount.
  - `app/(auth)/payment-registration.tsx`: the box sits above "Pay", and the button and amount show the discounted fee.
  - `i18n/{en,fr,rw,sw}.ts`.

**Interfaces:**
- Produces: `<PromoCodeInput appliesTo="ride"|"registration_fee" rideId? amount onChange={(applied: { code: string; discount: number; payAmount: number } | null) => void} />`
  - It renders a text box (uppercase, max 20) with an **Apply** button.
  - When applied, it shows a green line "−{discount} RWF · now {payAmount} RWF" and a **Remove** link.
  - On error it shows the server `message`.
- i18n keys `promo.label` "Promo code", `promo.apply` "Apply", `promo.remove` "Remove", `promo.applied` "−{{discount}} RWF · you pay {{payAmount}} RWF", `promo.placeholder` "Enter code".

- [ ] **Step 1: Add the i18n keys** to all 4 languages. Run `node --test tests/i18n-coverage.test.cjs`. Expected: PASS.
- [ ] **Step 2: Implement** the component and the screen changes.
- [ ] **Step 3: Check:** `npx tsc --noEmit -p .` shows 0 errors, and `node --test tests/` passes.
- [ ] **Step 4: Browser check** with the local stack and the Paypack stub (scratchpad `paystub.js`, `pay-screens.js` pattern):
  - an admin-created code applied on the MoMo ride screen charges the discounted amount;
  - a wallet ride with a code;
  - the fee screen with a code;
  - an invalid code shows its message.
- [ ] **Step 5: Commit** `Promo code box on ride payment and the registration fee`.

### Task 6: Admin panel: Promo codes page

**Files (admin repo):**
- Create: `src/pages/PromoCodesPage.tsx`
- Modify:
  - `src/api.ts`: `adminApi.promos.list/get/create/update/remove`;
  - `src/App.tsx`: route `promo-codes`;
  - `src/components/Shell.tsx`: nav item `['/promo-codes', 'Promo codes', Ticket, 'promo:view', 'Money']`;
  - `src/permissions.ts`: add `promo:view` and `promo:manage` to the Money group and the templates (superadmin and admin both, financial view).

**Interfaces:**
- Consumes: Task 2's API.
- **The page:**
  - **List:** a table of codes with status badges (status filter, search). Columns: code, for, discount, people "used / max", total uses, discount given, MOTA cost, status, actions.
  - **New / Edit dialog:** every field. The live example line reads "On a {sample} RWF {ride|fee}: {discount} off, pays {payAmount}". The `code` and `appliesTo` inputs are disabled after use.
  - **Switch on/off:** a PATCH of `active`.
  - **Delete:** asks for confirmation, then shows either "deleted" or "archived (it was used)".
  - **Detail drawer:** the totals and the redemptions table.
  - Actions are hidden without `promo:manage`.

- [ ] **Step 1: Branch** with `git -C /home/ishimchristian/mota-admin-web-app checkout -b claude/promo-codes-20261114 origin/main`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Check:** `npm run build` (or `npx tsc -b`) shows 0 errors, plus any admin test command in `package.json`.
- [ ] **Step 4: Browser check** against the local backend:
  - log in as a seeded superadmin;
  - create a code, see it listed, edit it;
  - delete an unused code;
  - the detail page shows a redemption made by the Task 5 check.
- [ ] **Step 5: Commit** `Promo codes page: create, edit, switch off, delete and monitor`.
