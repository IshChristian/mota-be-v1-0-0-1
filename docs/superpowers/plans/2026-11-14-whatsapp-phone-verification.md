# WhatsApp Phone Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an unverified user prove phone ownership by sending `MOTA verify <code>` to MOTA's WhatsApp number. This is free, with no template messages, and works as the backup while SMS is down.

**Architecture:** The backend issues a short-lived code and a `wa.me` link. The WhatsApp Cloud API webhook receives the user's message, matches the code, and checks that the sender's number equals the user's phone. It then runs the same activation as the SMS code and sends a free reply. The app opens the link and polls a status route.

**Tech Stack:** Express 5 (CommonJS), Mongoose, node:test + supertest (harness with a throwaway mongod); Expo Router React Native app.

**Spec:** `docs/superpowers/specs/2026-11-14-whatsapp-phone-verification-design.md`

## Global Constraints

- Never send a WhatsApp template message. The only outbound call is a free-form text reply to a number that just messaged us.
- The code is 6 digits, stored hashed (sha256), expires after **15 minutes**, and a new `start` replaces any earlier code.
- Message format: `MOTA verify <6 digits>`, matched case-insensitively with flexible spaces.
- Env: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_BUSINESS_NUMBER` (digits, e.g. `250788000000`). If any is missing, the feature is off and `start` returns 503.
- Reply copy (exact):
  - success `✅ Your MOTA number is verified. Go back to the app.`
  - mismatch `This WhatsApp number isn't the phone you signed up with.`
  - expired/unknown `That code has expired. Tap Verify with WhatsApp in the app again.`
- Backend work goes on new branch `claude/whatsapp-verify-20261114` from `origin/main`. App work goes on `claude/mota-backend-integration`.
- App strings must exist in en/fr/rw/sw (the `i18n-coverage` test enforces this).

## Review Focus

- A user stored as `0788…` messages from `250788…`: this must match. Compare `normalizeRwPhone(user.phone)` with the `+` removed against `from`. Test it in Task 2.
- Meta retries the same webhook delivery: a second success for an already-verified user must not re-run referral settlement or error. The code is cleared on success, so the retry hits "expired" and gets no second activation. Test it in Task 2.
- A webhook body that isn't a message (status callbacks, `statuses[]`) must return 200 without replying. Test it in Task 2.
- `start` for an already-verified user returns 400, and `start` for an unknown id returns 404. Test it in Task 1.
- The app is backgrounded while the user is in WhatsApp: polling must resume or re-check on foreground (`AppState` `active`). Covered by Task 3 manual check.

---

### Task 1: WhatsApp service, code issue, start + status routes

**Files:**
- Create: `services/whatsappService.js`, `controllers/whatsappVerifyController.js`, `routes/whatsappRoutes.js`, `tests/whatsapp-verify.test.js`
- Modify: `models/User.js` (add fields), `controllers/authController.js` (extract activation), `routes/authRoutes.js` (mount start/status), `app.js` (raw body + mount webhook router)

**Interfaces:**
- Produces:
  - `whatsappService.isConfigured(): boolean`
  - `whatsappService.sendText(to: string /*digits*/, body: string): Promise<boolean>`: POST `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages` with `{messaging_product:"whatsapp", to, type:"text", text:{body}}`. On failure it logs and returns false and never throws.
  - `whatsappService.verifySignature(rawBody: Buffer, header: string|undefined): boolean`: HMAC-sha256 with `WHATSAPP_APP_SECRET`, `sha256=` prefix, `crypto.timingSafeEqual`.
  - `authController.markPhoneVerified(user): Promise<void>`: the body pulled out of `verifyOTP` (set `isVerified`, activate client/passenger when not deleted, clear `otpToken`/`otpExpiry`, save, `referralService.trySettleReferral`). `verifyOTP` now calls it.
  - User fields: `waVerifyCodeHash: String`, `waVerifyExpiry: Date`. Add `waVerifyCodeHash` to the `toJSON` strip list.
  - Routes: `POST /api/auth/whatsapp/start {userId}` → `200 {link, expiresAt}` | 400 | 404 | 503. `GET /api/auth/whatsapp/status?userId=` → `200 {verified:boolean}` | 404.

- [ ] **Step 1: Write failing tests** in `tests/whatsapp-verify.test.js` (harness `startStack`; set the five `WHATSAPP_*` env vars in `before`; mock `global.fetch` as in `sms-service.test.js`):
  - `start returns a wa.me link with a 6-digit code`: create an unverified client; assert `link` matches `^https://wa\.me/250788000000\?text=MOTA%20verify%20\d{6}$` and `expiresAt` is ~15 min ahead (±5 s).
  - `start for a verified user is 400`, `start for unknown id is 404`.
  - `start is 503 when WhatsApp is not configured`: delete `WHATSAPP_TOKEN` for that test, then restore it.
  - `status reports verified false then true` (flip `isVerified` directly in the DB).
  - `verifyOTP still verifies via the shared helper` (an existing-behavior guard: post the correct SMS code and assert `isVerified` and `isActive`).
- [ ] **Step 2: Run** `node --test tests/whatsapp-verify.test.js`. Expected: FAIL (routes 404).
- [ ] **Step 3: Implement** the service, the User fields, the `markPhoneVerified` extraction, the controller `start`/`status`, and the mount in `routes/authRoutes.js`. In `app.js`, extend the `verify` hook so `req.rawBody` is also kept for `/api/webhooks/whatsapp`, and mount `app.use("/api/webhooks/whatsapp", whatsappRoutes)` (empty router for now; Task 2 fills it).
- [ ] **Step 4: Run** `node --test tests/whatsapp-verify.test.js tests/sms-service.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: issue WhatsApp verification links`.

### Task 2: Webhook — handshake, signature, match, reply

**Files:**
- Modify: `routes/whatsappRoutes.js`, `controllers/whatsappVerifyController.js`, `tests/whatsapp-verify.test.js`

**Interfaces:**
- Consumes: Task 1's `verifySignature`, `sendText`, `markPhoneVerified`, `normalizeRwPhone` (smsService).
- Produces:
  - `GET /api/webhooks/whatsapp`: if `hub.mode==="subscribe"` and `hub.verify_token===WHATSAPP_VERIFY_TOKEN`, return `200` with the text `hub.challenge`; otherwise 403.
  - `POST /api/webhooks/whatsapp`: if the signature is bad, return 401. Otherwise always return 200. For each `entry[].changes[].value.messages[]` with `type==="text"` and body matching `/^\s*mota\s+verify\s+(\d{6})\s*$/i`: find the user by `waVerifyCodeHash` with `waVerifyExpiry > now`.
    - Not found → expired reply.
    - Found but `normalizeRwPhone(user.phone).replace("+","") !== from` → mismatch reply, and the code is kept.
    - Found and matching → clear the `wa*` fields, call `markPhoneVerified`, send the success reply.
    - Log each outcome to `SmsLog` (type `otp`, phone `+from`, message = the reply, status sent/failed). Reuse SmsLog and do not add a new model.

- [ ] **Step 1: Write failing tests.** Add a helper `signed(body)` that returns `{raw, sig}` using the test secret.
  - `handshake echoes challenge with the right token`, `handshake 403 with wrong token`.
  - `unsigned or wrongly signed webhook is 401`.
  - `matching code from the user's number verifies and activates`: user phone `0788123456`, `from: "250788123456"`. Assert `isVerified`, `isActive`, `waVerifyCodeHash` cleared, and the fetch mock got the exact success copy to `250788123456`.
  - `code sent from another number does not verify`: assert not verified and the mismatch copy is sent.
  - `expired code gets the expired reply`: set `waVerifyExpiry` in the past.
  - `redelivered message does not verify twice`: post the same body twice and assert `trySettleReferral` side effects happen once (second reply is the expired copy).
  - `status callbacks get 200 and no reply`: body with `value.statuses` only, and the fetch mock is not called.
- [ ] **Step 2: Run** `node --test tests/whatsapp-verify.test.js`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the two handlers.
- [ ] **Step 4: Run** the full suite `pnpm test`. Expected: all pass (232+ before, plus the new ones).
- [ ] **Step 5: Commit** `feat: verify phones from incoming WhatsApp messages`. Also add the five `WHATSAPP_*` keys (empty) to `.env.example` if it exists.

### Task 3: App — Verify with WhatsApp on the code screen

**Files:**
- Modify: `services/api.ts` (authApi), `app/(auth)/otp.tsx`, `i18n/en.ts`, `i18n/fr.ts`, `i18n/rw.ts`, `i18n/sw.ts`

**Interfaces:**
- Consumes: Task 1 routes.
- Produces:
  - `authApi.whatsappStart(userId: string) → {link, expiresAt}`
  - `authApi.whatsappStatus(userId: string) → {verified}`
  - i18n keys under `auth`: `wa_verify` ("Verify with WhatsApp"), `wa_waiting` ("Send the message in WhatsApp, then come back here."), `wa_unavailable` ("WhatsApp verification isn't available right now."), `wa_open_again` ("Open WhatsApp again").

- [ ] **Step 1: Add the API calls and i18n keys** (translate fr/rw/sw). Run `node --test tests/i18n-coverage.test.cjs`. Expected: PASS.
- [ ] **Step 2: Add the button to `otp.tsx`** below the resend row, as an outlined button with a Feather `message-circle` icon.
  - On press: call `whatsappStart`, then `Linking.openURL(link)`, then switch to the waiting state (show `wa_waiting` plus `wa_open_again`).
  - A 503 hides the button and shows `wa_unavailable`.
  - While waiting, poll `whatsappStatus` every 3 s until `expiresAt`. Stop on unmount, and re-check immediately when `AppState` becomes `active`.
  - On `verified`, run the same success branch as `verifyOtp`: `updateUser({isVerified:true})` when signed in, otherwise `router.replace("/(auth)/login")`.
  - The button needs `userId`. If missing, hide it.
- [ ] **Step 3: Typecheck** with `npx tsc --noEmit`. Expected: no new errors in touched files.
- [ ] **Step 4: Manual web check:** `CI=1 npx expo start --web` against the local backend with fake `WHATSAPP_*` env.
  - Tapping the button opens a `wa.me` tab.
  - Simulating the webhook with a signed curl moves the screen on within ~3 s.
- [ ] **Step 5: Commit** `feat: verify phone with WhatsApp on the code screen`.
