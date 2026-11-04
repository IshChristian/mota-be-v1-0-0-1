# Direct cash-outs and staff access requests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send every withdrawal straight to Paypack with a held-funds manual fallback for staff, and give the superadmin fine-grained staff access with single-use access requests.

**Architecture:** Backend `withdrawalService` dispatches one request per Paypack call; refusals become `manual_required` and alert holders of `withdrawal:manage`. A new `AccessRequest` model plus a hook in `authorize()` lets an approved request authorise exactly one action on one target. Admin panel gets manual payout actions, a Requests page, a reusable `RequestAccess` guard and a full-permission Data Access editor.

**Tech Stack:** Node/Express/Mongoose 9 (CommonJS), node:test + supertest + real mongod harness; admin: React 19 + Vite + Tailwind, axios.

**Spec:** `docs/superpowers/specs/2026-11-04-cashout-fallback-and-staff-access-design.md`

## Global Constraints

- Backend branch `claude/cashout-staff-access-20261104` from `origin/main`; admin branch `claude/cashout-staff-access-20261104` from admin `origin/main`.
- Withdrawal minimum stays 100 RWF; no batching minimum (remove `PAYPACK_CASHOUT_MINIMUM` use).
- Money moves only inside MongoDB transactions with conditional updates.
- Users never see a raw Paypack error; a refusal still returns 202 "request received".
- New permissions: `withdrawal:view`, `withdrawal:manage`, `access_request:approve` (superadmin only; never grantable).
- Approved access requests: single use, same permission + same target, expire 24 h after approval.
- Every staff action → `auditService.log`; add new action names to `models/AuditLog.js` enum.

## Review Focus

1. Paypack call throws (network) instead of returning `success:false` → must still become `manual_required`, never 500 to the user, money held. (Test in Task 1.)
2. Two staff press "Paid manually" / "Return" at the same time → only one wins; held balance moves once. (Test in Task 2.)
3. Approved request used against a different user id or a different permission → refused. (Test in Task 4.)
4. Same approval used twice concurrently → exactly one succeeds. (Test in Task 4.)
5. Caller support hitting `/admin/paypack/transactions` or user detail → no wallet/transaction data. (Test in Task 3.)

---

### Task 1: Direct dispatch with `manual_required` fallback

**Files:** Modify `models/WithdrawalRequest.js`, `services/withdrawalService.js`, `controllers/walletController.js` (messages), `models/AuditLog.js`; Test: `tests/cashout.test.js`

**Interfaces — Produces:**
- `WithdrawalRequest.status` enum adds `"manual_required"`; fields `attempts: [{at, kind: "auto"|"retry", ok, paypackRef, reason, response}]`, `alertedAt: Date`, `alertedStaff: [ObjectId]`, `manual: {action: "paid"|"returned", by, at, reference, note}`.
- `dispatchRequest(requestId, kind = "auto") -> Promise<{status: "provider_pending"|"manual_required", paypackRef?, reason?}>` — claims `queued|manual_required → processing` conditionally, calls `paymentService.requestCashOut`, catches throws, records attempt, sets `provider_pending` + `paypackRef` on both request and its `cash_out` row, or `manual_required` + `failureReason` (money stays held) and calls `alertManualPayout(request, reason)`.
- `alertManualPayout(request, reason)` — notifies active staff whose effective permissions include `withdrawal:manage` (superadmins included) with title "Automatic cash-out failed" and message `Automatic cash-out of {amount} RWF for user {name} ({userId}) failed: {reason}. Pay it manually or return it to the wallet.`; sets `alertedAt`, `alertedStaff`.
- `requestWithdrawal` returns `{request, dispatch, replayed}` where dispatch comes from `dispatchRequest`.

- [ ] Tests (paymentService.requestCashOut stubbed per test): `direct payout below 10,000 goes to Paypack` (3,000 RWF → status provider_pending, attempts.length 1, ok true); `refusal holds money and alerts withdrawal managers` (success:false → status manual_required, wallet.balance unchanged minus totalHeld, heldBalance = totalHeld, a financial staff member has a Notification titled "Automatic cash-out failed", a caller_support one doesn't, HTTP response 202); `network error is a refusal` (stub throws → manual_required, 202).
- [ ] Run `node --test tests/cashout.test.js` → FAIL.
- [ ] Implement; update the user-facing messages in `walletController.requestCashOut` to "Withdrawal received. Payout usually arrives within 2 hours…" for both outcomes; drop queue wording and `paypackMinimum`.
- [ ] Run → PASS; run full `pnpm test` → existing suite still passes.
- [ ] Commit.

### Task 2: Staff manual payout, return, retry (backend)

**Files:** Modify `services/withdrawalService.js`, `routes/adminRoutes.js`, `constants/staffRoles.js`; Test: `tests/cashout.test.js`

**Interfaces — Produces:**
- `markPaidManually(id, staffId, {reference, note})`, `returnToWallet(id, staffId, {note})`, `retryPayout(id, staffId)` — first two only from `manual_required`, conditional update; paid: `heldBalance -= totalHeld`, request `successful`, `cash_out` row `successful` with `reference`, fee row `cash_out_fee`; returned: `balance += totalHeld, heldBalance -= totalHeld`, request + row `failed`; user notified "Withdrawal returned to your wallet".
- Routes: `GET /admin/withdrawals` → `withdrawal:view` (adds `manual_required` to allowed statuses, returns `attempts`, `manual`, `alertedAt`); `PATCH /admin/withdrawals/:id/review` → `withdrawal:manage`; `POST /admin/withdrawals/:id/manual-paid` (body `reference` ≥3 chars, `note`), `POST /admin/withdrawals/:id/return` (`note` ≥5), `POST /admin/withdrawals/:id/retry` → all `withdrawal:manage`; audit actions `withdrawal_manual_paid`, `withdrawal_returned`, `withdrawal_retry`.
- `staffRoles.js`: add the three permissions; superadmin/admin/financial templates get `withdrawal:view` + `withdrawal:manage`.
- `scripts/migrateCashoutAccess.js`: adds both withdrawal permissions to stored Role docs named admin/financial/superadmin; then dispatches every `queued` request via `dispatchRequest`.

- [ ] Tests: `manual paid releases held money once` (two concurrent calls → one 200, one 409; heldBalance 0, balance unchanged); `return puts money back` (balance restored, request failed); `retry goes to Paypack again`; `caller support cannot see or act on withdrawals` (403).
- [ ] FAIL → implement → PASS → full suite → commit.

### Task 3: Close money-data leaks for view-only staff

**Files:** Modify `routes/adminRoutes.js` (paypack routes), `controllers/adminController.js` (`getUsersList`, `getUserDetails`, `getUserOverview` already gated); Test: `tests/staff-access.test.js`

- [ ] Tests: caller_support `GET /api/admin/paypack/transactions` → 403; `GET /api/admin/users/:id/overview` → `wallet` null, `transactions` []; `GET /api/admin/users` rows contain no `walletBalance`/`balance` fields.
- [ ] Gate paypack transactions/events with `transaction:view`, sync with `transaction:sync`; strip money fields from list/detail unless `wallet:view`.
- [ ] PASS → commit.

### Task 4: Single-use access requests (backend)

**Files:** Create `models/AccessRequest.js`, `services/accessRequestService.js`, `routes/accessRequestRoutes.js` (mounted at `/api/access-requests` in `app.js`); Modify `middleware/authMiddleware.js` (`authorize`), `models/AuditLog.js`; Test: `tests/staff-access.test.js`

**Interfaces — Produces:**
- `AccessRequest {requesterId, permission, targetType, targetId (string|null), reason, status: pending|approved|declined|used|expired, decidedBy, decidedAt, decisionNote, expiresAt, usedAt}`.
- `POST /api/access-requests` (any staff with `admin:access`; permission must be in catalog and not already held; reason ≥5) → 201; superadmins notified "Access request".
- `GET /api/access-requests?mine=1` (own) / `GET /api/access-requests` (`access_request:approve`).
- `POST /api/access-requests/:id/approve|decline` (`access_request:approve`) → requester notified.
- `consumeApproval(userId, permission, targetId) -> Promise<boolean>`: atomic `findOneAndUpdate({requesterId, permission, targetId, status:"approved", expiresAt>now}, {status:"used", usedAt})`.
- `authorize()`: when the user lacks exactly one required permission, call `consumeApproval(user, missing, req.params.id || null)`; on true, audit `access_request_used` and continue.
- Audit actions: `access_requested`, `access_request_approved`, `access_request_declined`, `access_request_used`, `staff_permissions_updated`.

- [ ] Tests: `approved request allows one delete of that user only` (delete other user → 403; delete target → 200; second attempt → 403); `concurrent use consumes once`; `non-superadmin cannot approve` (403); `expired approval refused`.
- [ ] FAIL → implement → PASS → full suite → commit.

### Task 5: Per-person grants and revokes (backend)

**Files:** Modify `models/User.js`, `services/reportAccess.js` (`effectivePermissions`), `routes/reportRoutes.js`; Test: `tests/staff-access.test.js`

**Interfaces — Produces:** `User.permissionGrants: [String]`, `User.permissionRevokes: [String]`; `effectivePermissions = (role/template + reportPermissions logic) ∪ grants − revokes` (superadmin unchanged); `GET /api/reports/access/users` returns full `permissions` plus `grants`, `revokes`, `rolePermissions`; `PUT /api/reports/access/users/:id/permissions` body `{grants, revokes}` (`data:access_manage`, validated via `validateRoleGrant`; `access_request:approve` and `data:access_manage` only by superadmin) → audit `staff_permissions_updated`.

- [ ] Tests: grant `user:create` to caller_support → can `POST /api/admin/users`; revoke `user:view` from admin → 403 on users list.
- [ ] FAIL → implement → PASS → full suite → commit, push backend branch.

### Task 6: Admin panel — withdrawals, requests, guard, data access

**Files (admin repo):** Modify `src/api.ts`, `src/permissions.ts`, `src/pages/WithdrawalsPage.tsx`, `src/pages/DataAccessPage.tsx`, `src/components/Shell.tsx`, `src/App.tsx`, user/driver detail action buttons; Create `src/components/RequestAccess.tsx`, `src/pages/AccessRequestsPage.tsx`.

**Interfaces:**
- `api.ts`: `manualPaid(id, reference, note)`, `returnWithdrawal(id, note)`, `retryWithdrawal(id)`, `accessRequests(mine?)`, `createAccessRequest({permission, targetType, targetId, reason})`, `decideAccessRequest(id, "approve"|"decline", note)`, `staffPermissions(q)`, `updateStaffPermissions(id, grants, revokes)`.
- `<Guarded permission targetType targetId label>{children}</Guarded>`: renders children when `can(permission)` or an approved unexpired own request matches; else a "Request access" button opening a reason dialog; shows "Requested" while pending.
- Withdrawals page: nav and page under `withdrawal:view`; "Needs manual payout" count + filter; row actions Paid manually / Return to wallet / Retry under `withdrawal:manage`; attempts history in the detail dialog.
- Access requests page `/access-requests` (nav under `access_request:approve`, System group) with Approve / Decline.
- Data Access page: full permission matrix per staff member (grouped by category), toggling grants/revokes against the role baseline.
- `permissions.ts`: add new permissions to groups/templates.

- [ ] `npm run typecheck` and `npm run build` pass; `node --test tests/` passes.
- [ ] Visual check against local backend (seeded staff) with puppeteer screenshots of Withdrawals, Access requests, Data access.
- [ ] Commit, push admin branch.
