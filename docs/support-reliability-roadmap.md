# Support and reliability improvements

This is a proposal and implementation roadmap based on reported MOTA issues, not a verified inventory of missing features. Existing code reviewed here does not prove production deployment or end-to-end behavior.

## Included in this change

- Shared rider/driver Help & support screen: labelled inputs, selected issue categories, own request history with pagination, response target estimates, replies and reopening.
- Attach up to five files via the existing signed Cloudinary uploader. Successful uploads retain returned URLs; failures remain visible and retryable. This does not bypass Android file permissions or provider configuration.
- Account readiness summary: phone verification, KYC, driver-only registration fee, activation and saved availability, with account refresh and verification links. Help remains reachable during onboarding and account refresh failure.
- User-scoped support API, related-ride ownership checks, bounded input and write rate limits. Internal staff notes and contact history are excluded from user responses.
- Existing admin support workspace extended with public replies, private notes, resolution/status controls and attachment links. Existing support:view/support:update permissions continue to apply.
- Public staff replies create persistent operational inbox notifications. Notification taps route to the case; failed inbox requests show retry feedback instead of a false empty inbox. Push delivery is not newly enabled by this change.
- Swagger contracts for support creation, listing, case details, replies, reopening, staff replies and signed upload authorization. Automatic availability behavior is clarified.

## Existing components reused

Code includes admin support case CRUD, ride support operations, notification storage/inbox, safety requests, withdrawal review, permission assignment and reporting/export infrastructure. This change reuses those components; it does not assert their production completeness.

## Proposed next work, in order

1. Real Android/iOS upload acceptance checks covering camera, gallery, downloads, cloud document providers, revoked access and 20 MB limits; provider configuration and uploaded-asset checks with a controlled test account.
2. Support response escalation and staff queue alerts, notification retries and unread badges. Define owners and response targets before automated escalation.
3. Payment/withdrawal reconciliation timelines: provider-confirmed status, settlement references, duplicate prevention and failed-payment recovery. Display the two-hour withdrawal target as an estimate, not a guarantee.
4. Document expiry reminders and renewal actions with configurable reminder windows; preserve driver suspension and manually offline preferences.
5. Safety escalation playbooks, trusted-contact trip sharing and suspicious-activity review, with explicit response ownership and audited access.
6. Operational health/version checks, failure trend dashboards and privacy-conscious diagnostic references; exclude secrets and personal document contents from logs.
7. English/Kinyarwanda help content and accessibility/device testing.
8. Driver tips, performance statistics, heatmaps, destination filters and automated safety remain follow-up proposals requiring product decisions and validation.

## Validation and rollout

Backend controller tests cover account ownership, private-note filtering, attachment folder restrictions, related-ride ownership and notification failure after saving. These use controlled models; they do not verify Mongo persistence or actual Cloudinary delivery. Mobile type checking/Android export and admin production build check compilation. Deploy backend before clients so the new /api/support endpoints exist. SUPPORT_RESPONSE_TARGET_MINUTES defaults to 1440 (24 hours), constrained to 15–10080 minutes; it is a target only. Existing Cloudinary server credentials remain required. No unsigned preset is needed.
