# Roles and KYC review

## Implemented and confirmed by code review

- The role editor loads the backend's complete permission catalog and category groups; it no longer uses a separate UI list. A regression test checks every literal route authorization permission against this catalog.
- Admin can create named staff roles, assign allowed permissions, and select those roles during user creation or when changing an existing account's role. Custom names use the supported manager account type plus the Role record ID.
- Delegation checks apply to all permissions, not only reporting permissions. Superadmin ownership and reporting prerequisites remain protected. Assigned roles cannot be deleted before users are reassigned.
- The default admin template includes role:manage. Existing persisted role assignments remain authoritative: superadmin must explicitly add role:manage to an existing admin role where needed. No existing role is silently overwritten.
- KYC has paginated driver/rider queues and a complete detail view of submitted fields, files, dates, metadata and prior field reviews. Each submitted field can be approved or marked for correction with a reason.
- The new dashboard requires every submitted field approved before overall approval. Empty/unknown/duplicate field decisions and expired document approvals are rejected server-side. Legacy whole-record clients remain compatible; unresolved field corrections still block their approval.
- Reviews use updatedAt to reject concurrent/stale decisions. KYC/account status/driver activation writes share a MongoDB transaction. This requires a replica set or compatible MongoDB service, as the wallet transaction flow already does.
- Correction/rejection changes account KYC to basic and sets offline. Driver approval respects suspension/deletion safeguards. Resubmission clears old review decisions.
- User overview responses respect the independent KYC, finance, rides, loans, wallet and audit permissions. Audit records are redacted without audit:sensitive.
- Registration routes now use registration:view and registration:review. The UI disables review actions without that permission and prevents duplicate submissions.
- Driver detail polling no longer replaces unsaved personal forms. Outdated identity requests cannot replace another selected user's details.

## Verification and rollout

Deploy the backend before the paired admin UI. Swagger describes catalog, assignable roles, KYC list/detail and versioned per-field review contracts.

Local validation: admin production build; complete backend test suite. The live MongoDB integration test is skipped without its configured test database. Authenticated browser interaction and live transaction rollback must be checked in staging before production deployment.

Staging acceptance: create a limited role with admin:access and intended page permissions; create and log in as that user; confirm permitted/denied pages and API calls; assign a different custom role; submit driver/rider KYC; inspect every field; request correction; resubmit; approve every field; attempt a stale review; confirm account status, suspension safeguards and audit entries.

## Proposed follow-ups (not a verified inventory of missing features)

- Preview the effective permissions before assignment, explain permission dependencies, and offer reusable least-privilege templates.
- Add expiring staff grants and approval workflows for sensitive administrative changes.
- Add saved KYC queue filters, reviewer ownership, review turnaround metrics and expiring-document alerts.
- Deliver a precise user-facing correction checklist and notifications when per-field decisions change.
- Add a durable retry queue for independent referral settlement and notification delivery.
- Continue the page-by-page CRUD audit for rides, loans, settings and withdrawals, covering cancellation, repeated clicks, concurrent updates, accessibility and exports.
