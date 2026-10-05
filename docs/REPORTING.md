# Admin reporting and audit

Deploy this backend before the corresponding admin UI. Install locked dependencies (`pnpm install --frozen-lockfile`) and use a MongoDB replica set: report-access changes and their audit entries commit in a transaction. No reporting feature changes wallet balances.

## Access

Sign in as superadmin, open **Data access**, select an existing staff account and assign reporting scopes. Superadmin always retains ownership access. Existing stored role permissions remain authoritative; deployment does not silently broaden them. New scopes can also be added in **Staff & roles** by an account with `role:manage`.

| Scope | Access |
| --- | --- |
| analytics:view | Open analysis; section scopes also required |
| analytics:users | Users and verification |
| analytics:rides | Rides and driver performance |
| analytics:finance | Ledger, withdrawals and quality screening |
| analytics:operations | Referrals, demand, KYC, support and safety |
| analytics:export | Download allowed analysis reports |
| audit:view | Audit records and linked investigations |
| audit:export | Download permitted audit records |
| audit:sensitive | Personal audit fields; secrets still redacted |
| data:access_manage | Assign individual reporting scopes |

An individual `reportPermissions` array replaces reporting scopes inherited from a role. An empty array removes reporting access while preserving other permissions. Only superadmin may delegate access-management ownership. Other managers may grant only reporting permissions they currently hold. Role creation, assignment and permission updates apply the same reporting-scope checks. The legacy user role-assignment route now requires explicit authorization and delegates to the validated admin path; passenger and driver accounts cannot inherit staff permissions from mismatched role records. Grants exclude driver/passenger accounts and superadmin. Every request reads current permissions; the UI refreshes on focus and every minute. Revocation does not recall previously downloaded files.

## Reporting API

All endpoints require an active authenticated staff account with `admin:access`.

- `GET /api/reports/access/me` returns effective permissions.
- `GET /api/reports/access/users?q=...` lists up to 50 staff; manager scope required.
- `PUT /api/reports/access/users/:id` accepts `{ "permissions": [...] }` and atomically records before/after access.
- `GET /api/reports/summary?section=users` returns permitted aggregates and coverage notes.
- `GET /api/reports/records/:section` returns pages of 50 detail records.
- `GET /api/reports/investigate/:type/:id` returns up to 200 events and permitted related records (100 each).
- `GET /api/reports/export/:section/pdf` or `/xlsx` generates server-authorized files; limit five exports/minute/account.

Dates use `from`/`to` as YYYY-MM-DD, inclusive Africa/Kigali days, maximum 366 days. Optional `compare=true` compares equal preceding periods. Role narrows the user cohort. Status and exact record/user ID narrow detail rows; finance references and audit actions also support text search. Audit detail accepts action, actorId, targetType and targetId. Charts are date/cohort summaries; the UI explicitly labels detail-only filters. Exports contain the summary plus the first 2,000 matching detail rows and disclose cap/total. Export generation must create a durable audit record before returning bytes. Report responses are not cacheable.

## Definitions and limits

- Verification states are current values for accounts created in the period, not reconstructed historical states. Optional email and passenger fee exemption are labelled.
- Ride outcomes use booking cohorts; driver rankings use accepted-at cohorts. Offer metrics count acknowledged receipts, not unproven dispatch delivery.
- Wallet movements are not platform revenue. Current available/held balances are separate from period flows.
- Delay uses updatedAt minus createdAt; it is not a guaranteed settlement/resolution timestamp.
- Demand shows approximate 0.01-degree pickup bins containing at least five bookings, not individual coordinates.
- Support, safety events and ride disputes use existing persisted records. Upload metadata only includes backend-recorded uploads; missing direct-upload failure telemetry is unavailable.
- Ledger comparisons are review candidates, capped at 100. Opening balances, missing history and fee conventions can explain differences.
- Authentication failures, route failures, access decisions and password-login successes begin recording at deployment. Historical unrecorded events and alternative-login paths cannot be inferred.
- Audit content is read-only through these APIs, but is not a cryptographically immutable ledger. Secrets are always removed. Document URLs, personal free text and IPs are restricted without `audit:sensitive`.

## Verification

Run `pnpm test:reporting`. Unit/export checks run without MongoDB. Integration coverage is opt-in:

```
REPORT_TEST_MONGO_URI='mongodb://localhost:27017/mota_reporting_test?replicaSet=rs0' pnpm test:reporting
```

Use a disposable replica-set database only. The integration test drops **mota_reporting_test**, exercises all report aggregates and HTTP authorization, XLSX download auditing, atomic grants and immediate revocation. The URI must name this dedicated database.
