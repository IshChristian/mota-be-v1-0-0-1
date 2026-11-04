# Direct cash-outs with manual fallback, and staff access requests

Date: 2026-11-04 · Repos: `mota-be-v1-0-0-1` (backend), `mota-admin-web-app` (admin panel). The MOTA app (Mota-Digital) does not change.

## Why

1. **Cash-outs are slow.** Today a withdrawal is held until the driver's queued withdrawals add up to 10,000 RWF (`PAYPACK_CASHOUT_MINIMUM`), so a 3,000 RWF withdrawal can sit for days. That limit was a misunderstanding: Paypack accepts payouts from 100 RWF (confirmed by the owner, 2026-11-04). If Paypack refuses a payout, the driver gets an error and nobody at MOTA hears about it.
2. **Staff see and can do too much.** The superadmin wants to hand out narrow access: HR can add users but not delete them, and caller support can look users up without seeing money or changing anything. When someone needs to do one thing beyond their access, they should be able to ask for it on the spot.

## Part 1: Direct cash-out with manual fallback

### What the user sees (unchanged)

The driver or passenger taps Withdraw and enters an amount and phone number. The fee, the confirmation message and the wallet status work as today. Even when Paypack refuses, the user still sees "request received", never an error. They see the final outcome (paid, or money returned) in their wallet.

### What changes behind it

1. **Request.** As today, the amount plus the fee moves from `balance` to `heldBalance`, and a `WithdrawalRequest` and a pending `cash_out` transaction are created in one MongoDB transaction. Idempotency keys work as today.
2. **Send straight to Paypack.** Right after the hold, `requestCashOut(phone, amount)` is called for **this one request**, for any amount of 100 RWF or more (the existing request minimum). There is no queue; remove the 10,000 RWF batching and `PAYPACK_CASHOUT_MINIMUM`. Each request is its own batch of one, so the existing `batchId`, `paypackRef`, `releaseBatch` and `settleWebhook` logic keeps working.
3. **Paypack accepts** (`success` and a `ref`): status `provider_pending`. From here it works as today: the webhook or status poll marks it `successful`, or `failed` (money returned to the wallet).
4. **Paypack refuses, errors or times out:** the money **stays held**. The request moves to a new status, `manual_required`, and staff are alerted (below). Today this case releases the money; that changes.
5. **Staff handle it** in the admin panel, either way:
   - **Paid manually:** they pay through MoMo outside the system and enter the MoMo reference and a note. The held money and fee leave `heldBalance`, the request becomes `successful` (paid manually), and the pending `cash_out` transaction becomes `successful` with the reference.
   - **Return to wallet:** with a note. The held money and fee go back to `balance`, the request becomes `failed`, and the `cash_out` transaction becomes `failed`. The user is notified as on any failed withdrawal.
   - **Retry automatic payout** *(builder's addition, my call)*: sends the request to Paypack again, with the same outcomes as steps 3–4.

   Nothing happens automatically after a time limit. Held money returns only when staff choose "Return to wallet".
6. **A Paypack failure after acceptance** (the webhook says `failed` for a `provider_pending` request) works as today: the money returns to the wallet automatically. Only refusals at send time go to `manual_required`. *(My call: a later failure is a final answer from Paypack, not a stuck payout.)*

### Alerting staff

- When a request enters `manual_required`, every active staff account with `withdrawal:manage` gets an in-app staff notification (the existing notification service) and, where the existing support-alert channel allows, push/email. The message reads: "Automatic cash-out of {amount} RWF for user {name} ({userId}) failed: {reason}. Pay it manually or return it to the wallet."
- The admin Withdrawals page shows a **Needs manual payout** count and filter at the top.

### Recording everything

- `WithdrawalRequest.attempts[]`: one entry per Paypack attempt with `at`, `kind` (`auto` | `retry`), `ok`, `paypackRef`, `reason`, and a trimmed provider response. Never store credentials.
- `WithdrawalRequest.alertedAt` and `alertedStaff[]` (the ids notified).
- `WithdrawalRequest.manual`: `{ action: "paid" | "returned", by, at, reference, note }`.
- Every staff action is written to the audit log (`auditService`): `withdrawal_manual_paid`, `withdrawal_returned`, `withdrawal_retry`, plus the existing `withdrawal_reviewed`.
- The user's wallet history matches each step: pending while held, then successful or failed.

### Permissions

New: `withdrawal:view` (see withdrawals and their history) and `withdrawal:manage` (pay manually, return, retry). Default templates: superadmin, admin and financial get both; agent and caller support get neither. The existing `GET /admin/withdrawals` (now `finance:view`) and the review route (now `transaction:sync`) move to these.

### Anti-goals

- A refusal must never lose or double-spend money: held funds either leave once (paid) or return once (returned).
- A user must never see a raw Paypack error.
- No payout is sent twice for one request (retry only from `manual_required`, behind a conditional status update).

## Part 2: Staff access

### What exists today

- 5 built-in staff roles and ~60 permissions (`constants/staffRoles.js`); `authorize()` checks them on every admin route; superadmin bypasses.
- The admin panel's **Roles** page already creates custom roles (e.g. "hr") with any subset of the catalog, and you can't grant more than you have.
- The **Data Access** page edits only the reporting/audit permissions per person.
- The user overview already hides sections (wallet, transactions, loans, KYC) the viewer has no permission for.

### Changes

1. **Money stays hidden without money permissions.** Close the gaps where view-only staff see money:
   - `GET /admin/paypack/transactions` and `/admin/paypack/events` require `transaction:view` (now `user:view`); `POST /admin/paypack/sync` requires `transaction:sync` (now `user:update`).
   - Audit every admin `GET` that returns users (list, details, search, agents) and strip wallet balance, held balance, transactions, payment methods, loans and savings unless the viewer has the matching permission (`wallet:view`, `transaction:view`, `loan:view`, `savings:view`). National ID numbers and KYC documents need `kyc:view`.
   - The caller support template stays view-only: basic details (name, phone, role, status, rides) and support tools, with no money and no create/update/delete.
2. **Request access button.** In the admin panel, any create/update/delete action the person can't do shows **Request access** instead of being hidden. Pressing it asks for a short reason and sends a request to the superadmin.
   - A request holds: requester, permission (e.g. `user:delete`), target (`targetType` + `targetId`, e.g. that user), reason, and status `pending` → `approved` | `declined` → `used` | `expired`.
   - Superadmins get a notification and see a **Requests** page with Approve / Decline (with optional note).
   - **Approval is single-use:** it allows that one action on that one target. The backend's `authorize()` accepts the request only when the permission and target match, then marks it `used` in the same step, so it can't be reused. *(My call: an unused approval expires after 24 hours.)*
   - The requester is notified of the decision, and the button becomes the real action while the approval is valid.
   - Requesting is open to all staff; approving is superadmin-only (`access_request:approve`, never in any template but superadmin).
3. **Data Access page covers everything.** It shows each staff member's full effective permissions (from their role, plus per-person extras). The superadmin can add or remove any single permission for one person, not just reporting ones, without editing their role. *(My call: stored as per-person `grants`/`revokes` next to the role, merged in `effectivePermissions`.)*
4. **Everything recorded.** Role edits, per-person changes, access requests, approvals, declines and uses all go to the audit log, with who, whom, what and when.

### Anti-goals

- No permission check only in the UI: the backend refuses every action it doesn't allow, approved requests included.
- An approval must never widen into general access (other targets, other actions, or repeat use).
- Nobody except a superadmin can approve requests or grant `data:access_manage` / `access_request:approve`.

## Constraints

- Production deploys the backend's `main`. Build on `origin/main`; other open branches (`claude/ride-commission-20261104`, `claude/settings-auth-admin-20261102`) are separate and merge independently.
- Admin panel: build on its `main`; the unmerged `claude/admin-settings-auth-20261102` branch stays separate.
- Wallet changes use MongoDB transactions with conditional updates, as the existing wallet code does.
- Tests: backend integration tests (`tests/`, real mongod harness) for every money path and permission rule. Paypack is stubbed in tests.

## Left to the builder

Model and route names, exact admin UI layout (within the existing pages' style), notification wording beyond the alert above, and notification wording beyond the alert above.

**Existing `queued` withdrawals** *(my call)*: a one-off script (`scripts/dispatchQueuedWithdrawals.js`), run once after deploy, sends each through the new path (accepted → `provider_pending`, refused → `manual_required` with alert). The PR says to run it.
