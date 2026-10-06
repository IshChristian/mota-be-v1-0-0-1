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

## Staff queue and inbox continuation (6 October 2026)

- Authorized active staff (admin:access + support:view, using effective role permissions) receive generic inbox alerts for new cases, user replies/reopening and passed response targets. No personal details are placed in these alert messages.
- The existing server cron initialization starts a one-minute support scan. A sparse unique notification deduplication index is ensured before scanning. Upserts deduplicate per case/event/revision/recipient; partial write failures leave the revision pending for retry. Each pass handles at most 200 cases and writes recipient batches of 25. Existing active cases without the new revision field are not announced as new requests; their stored overdue targets can still be escalated. This is in-app delivery, not push/SMS.
- Public staff replies clear the pending response target; new user replies/reopening start another estimated target. Private notes do not reset the target or notify users. Existing manual escalation is preserved until staff changes it.
- Admin notification bell links to a paginated inbox with unread count, unread-only filtering, mark-as-read and permission-aware support case links. Failed count fetches display an unavailable indicator instead of a false zero.
- Staff queue has all/active/overdue/urgent views, pagination and whole-queue counts. Source filtering is explicitly labelled as applying to the current page.
- Support action prompts/confirmations use custom labelled dialogs with keyboard focus handling; resolving/closing sends a public reply rather than silently changing status.
- Own inbox reads and marking/deleting notifications remain authenticated but work during onboarding/deactivation. Push-token registration still uses the full account gate.
- Swagger documents staff queue/summary, bounded inbox pagination and updated conversation behavior.

## Public reply delivery and mobile inbox continuation

- A public staff reply stores a pending inbox-update flag with its message. The HTTP response does not wait for notification storage. Failed writes or acknowledgements are retried by the one-minute scheduler, including after a case is closed; private notes never enter this queue.
- A unique key per case/message/recipient prevents duplicate records on retry and preserves the notification's read status. Successfully acknowledged writes record a timestamp; the admin conversation displays queued/recorded feedback and refreshes without clearing a reply draft.
- Mobile inbox supports all/unread views and page navigation. Malformed inbox responses show an error rather than an empty list. Driver dashboard and rider account show actual unread counts instead of a static dot; count polling pauses while the app is backgrounded.
- Authenticated users can open their inbox during onboarding or account refresh failure. User queries remain account-scoped.
- Historical public replies are not automatically replayed; only new messages explicitly marked pending are queued. Browser/device, live Mongo concurrency and Cloudinary/provider acceptance remain unverified.

## Existing components reused

Code includes admin support case CRUD, ride support operations, notification storage/inbox, safety requests, withdrawal review, permission assignment and reporting/export infrastructure. This change reuses those components; it does not assert their production completeness.

## Proposed next work, in order

1. Real Android/iOS upload acceptance checks covering camera, gallery, downloads, cloud document providers, revoked access and 20 MB limits; provider configuration and uploaded-asset checks with a controlled test account.
2. Push/SMS escalation channels, response ownership playbooks and provider delivery receipts. Public reply retries and mobile unread badges are included. The admin inbox, staff inbox-write retries and target-based queue escalation are included; they do not guarantee a staffed response.
3. Payment/withdrawal reconciliation timelines: provider-confirmed status, settlement references, duplicate prevention and failed-payment recovery. Display the two-hour withdrawal target as an estimate, not a guarantee.
4. Document expiry reminders and renewal actions with configurable reminder windows; preserve driver suspension and manually offline preferences.
5. Safety escalation playbooks, trusted-contact trip sharing and suspicious-activity review, with explicit response ownership and audited access.
6. Operational health/version checks, failure trend dashboards and privacy-conscious diagnostic references; exclude secrets and personal document contents from logs.
7. English/Kinyarwanda help content and accessibility/device testing.
8. Driver tips, performance statistics, heatmaps, destination filters and automated safety remain follow-up proposals requiring product decisions and validation.

## Validation and rollout

Backend controller tests cover account ownership, private-note filtering, attachment folder restrictions, related-ride ownership and notification failure after saving. These use controlled models; they do not verify Mongo persistence or actual Cloudinary delivery. Mobile type checking/Android export and admin production build check compilation. Deploy backend before clients so the new /api/support endpoints exist. SUPPORT_RESPONSE_TARGET_MINUTES defaults to 1440 (24 hours), constrained to 15–10080 minutes; it is a target only. Existing Cloudinary server credentials remain required. No unsigned preset is needed.
