# Promo codes for ride payments and the driver registration fee

Date: 2026-11-14 · Status: approved by owner 2026-11-14
Repos and branches:
- Backend `mota-be-v1-0-0-1`, branch `claude/promo-codes-20261114`, built on PR #53 (`claude/payment-verified-phone-20261114`).
- App `Mota-Digital`, branch `claude/mota-backend-integration`.
- Admin `mota-admin-web-app`, new branch `claude/promo-codes-20261114` from `origin/main`.

## Why

The owner wants promotions. Passengers type a promo code when they pay for a ride, and drivers type one when they pay the registration fee; either way the code gives a discount. Admins create, edit, delete and monitor codes in the admin panel (MOTA Control). Nothing like this exists today in the backend, the app or the admin panel.

## Decisions made by the owner (2026-11-14)

1. **MOTA pays for ride discounts.** The driver always receives their normal earning on the full fare. MOTA's commission absorbs the discount, and anything beyond the commission is a cost to MOTA.
2. **Ride codes work on mobile money rides and wallet rides** paid in the app. They do not work on cash rides.
3. **Approach: promo codes are their own records, and the backend computes the discount at the moment of payment.** The app only sends the code text.
4. **Number of people per code:** admins set how many different people can use a code (`maxUsers`), plus uses per person.
5. **Promo cost is shown only on the new Promo codes pages (A).** The existing Finance pages and reports are unchanged, so they still count full commission on promo rides; no `Transaction` row is added for the promo cost. MOTA's cost lives on `PromoRedemption.subsidy` and the code's `subsidyTotal`.

## Approaches considered

1. **Separate PromoCode and redemption records, with the discount computed server-side at payment (chosen).** Limits hold under concurrency, and the cost of each code is traceable in the ledger.
2. **Turn the discount into wallet credit before paying.** Rejected: the credit could be spent elsewhere or withdrawn, and the cost isn't traceable to the code.
3. **The app computes the price.** Rejected: a client could pay any price.

## Goals

- An admin can create a code. It has:
  - **code text**: 3–20 characters `A–Z 0–9 -`, case-insensitive (stored uppercase) and unique;
  - **for**: `ride` or `registration_fee`;
  - **discount**: `percent` (1–100, optional `maxDiscount` RWF cap) or `fixed` (RWF);
  - **optional** `minAmount` (the fare or fee must be at least this), `startsAt` and `endsAt`;
  - **`maxUsers`** (optional): how many **different people** can use the code, e.g. the first 100 people (owner request, 2026-11-14). Empty means no limit;
  - **`perUserLimit`** (default 1);
  - **`active`** on/off;
  - an **internal note**.
- **Admins can edit codes.** The code text and the "for" field cannot change once the code has been used.
- **Admins can delete codes.** A code that was never used is removed for good. A used code is archived instead: switched off and hidden from the default list, with its history kept.
- **Admins can monitor:**
  - **The code list shows:** status (active / scheduled / expired / used up / off / archived), **people who used it against `maxUsers`** (e.g. "37 of 100 people"), total uses, total discount given, and MOTA's extra cost on rides (the discount minus the commission).
  - **The code detail page shows the uses:** who, when, ride or fee, original amount, discount, amount paid, and how it was paid.
- **Passengers** see a "Promo code" box with an **Apply** button in two places:
  - above "Pay · MoMo" on a mobile money ride;
  - above "Confirm arrival" on a wallet ride.
- **Drivers** see the same box on the registration-fee screen.
- **Apply previews the result.** It shows the discount and the new price (old price struck through), or the reason the code can't be used (unknown, not started, expired, used up, already used by you, not for this payment, below the minimum amount).
- **A use counts only when the payment succeeds.** A failed or abandoned mobile money prompt gives the use back.
- **If the discounted price is under 100 RWF** (the mobile money minimum), nothing is collected by mobile money. The ride or fee is marked paid straight away, and MOTA covers the rest.

## Non-goals

- Cash rides, wallet deposits, withdrawals, fines and loans.
- Codes tied to specific people, codes applied automatically, and referral codes (referrals already exist separately).
- Sending promo codes to users (SMS, push or marketing).
- CSV export of uses. This could come later; the detail page lists them.

## Anti-goals

- **The client never decides the price.** The amount charged is always computed by the backend from the code and the stored fare or fee.
- **Driver earnings never drop because of a promo.** The driver is credited on the full `ride.fare`.
- **Limits are never exceeded,** even when two people use the last slot at the same moment.
- **A failed or abandoned payment never permanently uses up** someone's per-user use or a person slot in `maxUsers`.

## Design

### Data (backend)

**`PromoCode`** fields:
- code text: `code` (unique, uppercase);
- what it is: `appliesTo`, `discountType`, `value`, `maxDiscount?`, `minAmount?`;
- when it can be used: `startsAt?`, `endsAt?`, `active`;
- limits: `maxUsers?` (different people), `perUserLimit` (default 1). The most uses possible is `maxUsers × perUserLimit`;
- admin details: `note?`, `createdBy`, `updatedBy`, `archivedAt?`;
- counters: `usersCount` (people holding at least one reserved or redeemed use), `redeemedCount`, `reservedCount`, `totalDiscount`, `subsidyTotal`, kept in step atomically;
- timestamps.

**`PromoRedemption`** fields:
- who and what: `promoId`, `code`, `userId`, `appliesTo`, `rideId?`;
- the payment: `paymentRef?` (Paypack ref), `method` (`momo` | `wallet` | `none`);
- the money: `originalAmount`, `discount`, `paidAmount`, `subsidy` (MOTA's extra cost on rides: `max(0, discount − commission)`);
- state: `status` (`reserved` | `redeemed` | `released`), `reservedAt`, `redeemedAt?`, `releasedAt?`.

There is one active (reserved or redeemed) redemption per ride, and per fee payment of a user.

### Rules (one service, `services/promoService.js`)

- **`quote({ code, appliesTo, userId, amount })`** returns `{ discount, payAmount }` or throws a coded error.
  - The **discount** for a percentage code is `round(amount × value / 100)`, capped by `maxDiscount`. For a fixed code it is `value`. It is never more than `amount`.
  - **`payAmount`** is `amount − discount`.
- **Checks, in this order:**
  1. the code exists and is not archived;
  2. it is active;
  3. it applies to this kind of payment;
  4. it has started;
  5. it has not ended;
  6. the amount is at least `minAmount`;
  7. a **new person** can take a place only while `usersCount < maxUsers` (someone who already holds a use doesn't take a new place);
  8. this user's redeemed plus reserved uses are below `perUserLimit`.
- **`reserve(...)`** checks the limits and records the reservation in one atomic step.
  - For a person's first active use, it increments `usersCount` and `reservedCount` with a conditional `findOneAndUpdate` (`usersCount < maxUsers`).
  - Otherwise it only increments `reservedCount`, after checking `perUserLimit`.
  - It then creates the `reserved` redemption.
  - When a release leaves a person with no reserved or redeemed use, `usersCount` goes down by one, so their place frees up.
- **`redeem(redemptionId, { paymentRef?, subsidy })`** moves it from reserved to redeemed (`reservedCount −1`, `redeemedCount +1`, `totalDiscount += discount`, `subsidyTotal += subsidy`).
  - This is idempotent: a second call does nothing.
- **`release(redemptionId)`** moves it from reserved to released.
  - **A reservation lives as long as its payment** (my call; it keeps both anti-goals). A reservation linked to a Paypack ref stays `reserved` while that payment is pending, however long Paypack takes. It is released only when the payment is reported `failed`. So a late success always finds it `reserved` and redeems normally: limits are never exceeded and a paid discount is never lost.
  - Only a reservation with **no** payment ref (the prompt was never sent) is released automatically after **30 minutes**. This runs in the existing cron, and also lazily inside `quote`/`reserve` for that code.

### Payment flows

**Ride, mobile money (`POST /api/rides/:id/pay` with `{ phone?, promoCode? }`)**
- With a code, the backend quotes against `ride.fare`, reserves the use, and charges `payAmount` to the number.
- The Transaction stores `amount: payAmount`, and also `originalAmount: ride.fare` and `promoRedemptionId`.
- The webhook ride-payment branch credits the driver from `calculateCommission(ride.fare)` instead of the paid amount, so the driver earns on the full fare. That branch also serves driver-logged rides and USSD ride payments, so it uses `ride.fare` **only** when the transaction has a `promoRedemptionId`. Otherwise it keeps today's paid-amount calculation, and those paths don't change.
- On success it calls `redeem`, which records the discount and MOTA's extra cost (`subsidy`) on the redemption and the code (decision 5: no ledger row).
- On failure it calls `release`.
- If `payAmount < 100`, no prompt is sent. The ride is settled at once: the driver is credited, the payment is marked successful, and the code is redeemed.
- A second tap while a payment is pending keeps today's behaviour (it returns the pending ref), and the code can't be changed mid-payment.
- **Paying again** (my call): if the ride's mobile money payment has `failed`, `POST /rides/:id/pay` starts a fresh payment (clearing the old `paypackRef`), with or without a code.

**Ride, wallet (`POST /api/rides/:id/confirm-stop` with `{ promoCode? }`)**
- Inside the existing transaction, the passenger's wallet is debited `payAmount`. The driver is credited `driverEarning` from the full `ride.fare`.
- The redemption is reserved and redeemed in the same transaction, with its `subsidy` recorded (no ledger row).
- A wallet balance below `payAmount` gives the usual "Insufficient wallet balance" error, and the code is not used.

**Registration fee (`POST /api/auth/pay-registration` with `{ phone, payerPhone?, promoCode? }`)**
- A `promoCode` requires the driver's own session, like `payerPhone`.
- **Drivers only** (my call; the app has no agent flow). An agent sending a code gets 400 "Promo codes are for driver registration."
- The backend quotes against the configured fee and reserves the use. The user is linked to the redemption (`registrationPromoRedemptionId`).
- It charges `payAmount`. If `payAmount < 100`, the fee is marked paid at once (the existing "free" path) and the code is redeemed.
- When the webhook or registration-status marks the fee paid, the code is redeemed. A fee has no driver earning, so `subsidy` is 0 and the `discount` is MOTA's lost revenue.

**Preview: `POST /api/promos/preview`** (signed in) with `{ code, appliesTo, rideId? }`
- For a ride, the amount is that passenger's ride fare (the ride must be theirs and awaiting payment). For a fee, it is the configured fee.
- It returns `{ code, discount, payAmount, originalAmount }`, or **400** `{ reason, message }` with a plain message.
- It never reserves anything.

### Admin API (backend)

New permissions `promo:view` and `promo:manage`:
- Superadmin and admin get both. Financial gets `promo:view`.
- They are added to `constants/staffRoles.js`, plus a one-off script `scripts/migratePromoPermissions.js` that adds them to stored roles, like `migrateCashoutAccess.js`.

Endpoints:

| Endpoint | Permission | What it does |
|---|---|---|
| `GET /api/admin/promos?status=&appliesTo=&q=` | `promo:view` | Lists codes with their computed status and counters. |
| `GET /api/admin/promos/:id` | `promo:view` | The code, plus its redemptions (newest first, paginated). |
| `POST /api/admin/promos` | `promo:manage` | Creates a code (validated). |
| `PATCH /api/admin/promos/:id` | `promo:manage` | Edits a code. Code text and `appliesTo` are locked once `redeemedCount + reservedCount > 0`. |
| `DELETE /api/admin/promos/:id` | `promo:manage` | Hard delete if never used; otherwise archive. |

Every create, update or delete writes an AuditLog entry (`promo_created` / `promo_updated` / `promo_deleted`, added to the AuditLog action enum).

### Admin panel (mota-admin-web-app)

A **Promo codes** page under Finance or Operations, following the FuelVouchersPage pattern:
- **List:** status filters, search, a "New code" button, and per-row actions (edit, switch on/off, delete or archive). It is shown only with `promo:view`; the actions need `promo:manage`.
- **Create and edit form:** every field above, validated the same way as the backend. It shows a live example, e.g. "On a 2,000 RWF ride: 400 off, passenger pays 1,600".
- **Detail:** totals (uses, discount given, MOTA extra cost) and the redemptions table.

### App (Mota-Digital)

- **`components/payments/PromoCodeInput.tsx`:** a text box (uppercase, max 20) with an **Apply** button.
  - Apply calls the preview. A valid code shows a green line with the discount, the old price struck through and the new price, plus "Remove".
  - An invalid code shows the reason.
  - The applied code is passed up so the pay call sends `promoCode`.
- **Where it appears:**
  - `TripPanel` above "Pay · MoMo" (mobile money rides);
  - `TripPanel` above "Confirm arrival" (wallet rides);
  - the registration-fee screen above "Pay".
- **Button labels** show the price to be paid, e.g. "Pay 1,200 RWF · MoMo".
- **New copy** in en/fr/rw/sw.

## Left to the builder

- Exact indexes, pagination size, and the cron hook for the 30-minute release.
- How preview errors map to the plain messages listed above.
- Admin panel placement in the navigation.
- **Tests, at minimum:**
  - discount maths: percentage, cap, fixed, never above the amount;
  - each refusal reason;
  - the last person place taken concurrently by two users: only one succeeds;
  - per-user limit;
  - `maxUsers`: the 101st different person is refused, but a person already counted can still use their remaining uses; a released-only person frees their place;
  - a failed mobile money payment releases the use;
  - a stale reservation is released after 30 minutes;
  - a mobile money ride with a code: Paypack is charged `payAmount`, the driver is credited on the full fare, and the redemption records the discount and subsidy;
  - a wallet ride with a code;
  - under 100 RWF settles without a prompt;
  - a fee with a code, including the free path;
  - `promoCode` on the fee needs a session;
  - admin CRUD and permissions;
  - deleting a used code archives it;
  - code text is locked after use;
  - audit rows are written.
