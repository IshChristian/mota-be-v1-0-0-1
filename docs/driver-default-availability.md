# Driver default availability

Full-KYC driver sessions request online automatically when the fresh account shows offline and availabilityManuallyOffline is false/missing. The normal phone, registration-fee, activation and document-validity checks still apply. Full KYC activation continues through the existing driver activation policy; administrative suspensions remain respected.

Manual availability updates persist availabilityManuallyOffline alongside isOnline. This flag is returned by getMe and survives app restarts. A completed new password/2FA login clears the preference, allowing the mobile account refresh to go online again. Driver logout atomically sets isOnline=false and the manual-offline flag while incrementing tokenVersion; session revocation follows as before. Logout still preserves active ride records.

Mobile automatic requests send automatic=true. The backend checks the manual preference and current session token version atomically before enabling availability. This prevents an in-flight automatic request from undoing manual offline/logout. Legacy records without tokenVersion are supported as version zero. Concurrent updates, saved preferences, session lifecycle and legacy versions are covered by controlled model tests; real device/server lifecycle testing remains required. Deploy this backend change before the matching mobile change.
