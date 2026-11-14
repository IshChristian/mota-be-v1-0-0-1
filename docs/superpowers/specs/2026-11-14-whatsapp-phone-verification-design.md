# Verify phone numbers through WhatsApp (free fallback for SMS)

Date: 2026-11-14 · Status: awaiting approval

## Why

All SMS have failed since 2026-03-18 because Pindo has no approved sender ID. New users can't verify their phone, so passengers never become active and drivers can't move on to KYC. The owner wants a backup that **costs nothing** and works while SMS is down.

## Approaches

1. **Reverse verification on the official WhatsApp Cloud API (chosen).** The user sends a message to MOTA's WhatsApp number. Messages users send in are free, and so are MOTA's free-form replies within 24 hours. The number the message comes from proves the user owns that phone. This is allowed by WhatsApp, so the number can't be banned for it. It only works for things the user starts, which means verification.
2. Codes sent by MOTA as WhatsApp authentication templates. These are reliable and official, but they are **paid** per message. Rejected because of the cost.
3. Unofficial WhatsApp Web bot (Baileys / whatsapp-web.js). It's free and can send anything, but it breaks WhatsApp's rules, the number risks a ban, and its session doesn't survive Render restarts. Rejected.

## Goals

- On the phone-code screen, the user can tap **Verify with WhatsApp** and finish verifying without ever getting an SMS.
- A successful WhatsApp check has exactly the same effect as a correct SMS code: `isVerified = true`, passengers become active, and referral settlement runs.
- The cost is zero. No template messages are ever sent.

## Non-goals

- Ride, wallet, loan and referral notices over WhatsApp. They stay on SMS or in-app.
- Verifying a new phone when a user changes their number (`/users/me/contact-change`). This is a possible follow-up.
- Password reset. It is email-only today.
- Removing SMS. Pindo stays and starts working again once a sender ID is approved.

## Anti-goals

- Anything that sends a paid message or depends on an unofficial WhatsApp client.
- Marking a phone as verified when the WhatsApp sender's number is not the user's registered phone.

## Design

### Backend (mota-be-v1)

- **`services/whatsappService.js`**
  - Reads `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_BUSINESS_NUMBER`.
  - `sendText(to, body)` sends a free-form reply through the Graph API. It is only used inside the 24-hour window.
  - When the variables are missing, the feature reports itself as off.
- **`POST /api/auth/whatsapp/start { userId }`**
  - Requires the user to exist and be unverified.
  - Creates a 6-digit code, stores it hashed on the user with a 15-minute expiry, and replaces any earlier code.
  - Returns `{ link: "https://wa.me/<business number>?text=MOTA%20verify%20<code>", expiresAt }`.
  - Returns 503 when WhatsApp isn't configured.
  - Rate-limited like the other auth routes.
- **`GET /api/auth/whatsapp/status?userId=`** returns `{ verified: boolean }` and nothing else.
- **`GET /api/webhooks/whatsapp`** answers Meta's subscription handshake (`hub.verify_token` → `hub.challenge`).
- **`POST /api/webhooks/whatsapp`**
  - Checks `X-Hub-Signature-256` against the raw body using `WHATSAPP_APP_SECRET`. This means extending the existing `rawBody` capture in `app.js`.
  - Always answers 200 quickly.
  - For each text message matching `MOTA verify <6 digits>`:
    - It finds the user with that unexpired code.
    - It requires the sender (`from`, digits only) to equal the user's phone in normalized `250…` form.
    - **Match:** it runs the same activation as `verifyOTP`, which should be pulled into one shared function, clears the code, and replies "✅ Your MOTA number is verified. Go back to the app."
    - **Number mismatch:** it replies "This WhatsApp number isn't the phone you signed up with."
    - **Unknown or expired code:** it replies "That code has expired. Tap Verify with WhatsApp in the app again."
  - Messages that match nothing get no reply.
- Every attempt is logged, reusing `SmsLog` with `channel: "whatsapp"` or a sibling model (the builder decides).

### App (Mota-Digital)

`app/(auth)/otp.tsx` gets a second button under the code boxes, **Verify with WhatsApp**. It is always shown while SMS is unreliable, and hidden if `start` returns 503.

- Tapping it calls `start` and then opens the link (`Linking.openURL`; a new tab on web).
- The screen then shows "Send the message in WhatsApp, then come back".
- It polls `status` every 3 s for up to 15 min while the screen is focused, and checks once more when the app returns to the foreground.
- `verified: true` → the screen continues exactly as a correct SMS code would.
- New strings are added to all four languages (en/fr/rw/sw), as the i18n parity test requires.

### Setup the owner must do (one time, free)

1. Create a Meta developer app with the WhatsApp product, under a Meta Business account.
2. Add a phone number that is **not** already on the WhatsApp app. A test number is enough for development.
3. Create a permanent token through a System User.
4. Point the webhook to `https://mota-be-v1-0-0-1.onrender.com/api/webhooks/whatsapp` and subscribe to `messages`.
5. Set the five `WHATSAPP_*` variables on Render and in `.env`.

## Left to the builder

- The exact code storage fields and whether to reuse `SmsLog`.
- The poll interval details.
- Tests: signature rejection, sender mismatch, expired code, success activates a passenger, and `start` returns 503 when unconfigured.
