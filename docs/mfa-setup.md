# User MFA (two-factor authentication)

Built on Supabase Auth native MFA. Users manage their own methods in
**Settings → My Profile → Security → Two-Factor Authentication**; admins can reset a user's MFA from
**Settings → My Staff → (user) → ⋮ → Reset Two-Factor**.

## What the app does

| Flow | Where | Supabase calls |
|---|---|---|
| Add authenticator app | Security tab | `mfa.enroll({factorType:'totp'})` → QR + manual key → `mfa.challengeAndVerify` |
| Add SMS | Security tab | `mfa.enroll({factorType:'phone', phone})` → `mfa.challenge({channel:'sms'})` → `mfa.verify` |
| Remove a method | Security tab | fresh code from any verified method (`challenge`/`verify`) → `mfa.unenroll` |
| Sign-in second step | `/login` | after password/Google/Microsoft sign-in, if `getAuthenticatorAssuranceLevel()` is `aal1 → aal2` the challenge screen is shown before the app |
| Route guard | `ProtectedRoute` / `AuthContext` | every protected route requires `aal2` when the user has a verified factor; the aal claim is in the persisted session, so reloads stay guarded |
| Admin reset | Staff drawer → edge function `admin-mfa-reset` | service role `auth.admin.mfa.listFactors` / `deleteFactor` (also signs the user out everywhere) |

Accounts without a verified factor (including the CLARA / FRIDAY agent service accounts, which sign
in programmatically) are `aal1 → aal1` and never see a challenge. Nothing is forced on anyone: MFA
is opt-in per user.

## Supabase dashboard steps (project `<your-project-ref>`)

These are Auth settings the code cannot change.

### 1. Authenticator apps (TOTP)

Authentication → Multi-Factor
(`https://supabase.com/dashboard/project/<your-project-ref>/auth/mfa`):

- **TOTP (App Authenticator)**: Enabled (enroll + verify). This is the Supabase default; confirm it.

No other setup and no extra cost. If it is off, enrolling shows "Authenticator app verification is
not enabled for this workspace".

### 2. SMS (Phone MFA)

Phone MFA is opt-in and is a **paid Supabase add-on** ("Advanced MFA Phone", billed hourly while
enabled; Supabase lists it at about $75/month for the first project on Pro/Team, plus per-message
SMS costs at the provider). It needs two things:

1. **An SMS provider configured in Supabase Auth.** Authentication → Sign In / Providers → **Phone**
   (`https://supabase.com/dashboard/project/<your-project-ref>/auth/providers`). Choose
   **Twilio** and enter:
   - Twilio **Account SID**
   - Twilio **Auth Token**
   - Twilio **Messaging Service SID** (or a from-number, depending on the provider form)

   This is **separate from the OS's own Twilio integration** (Settings → Phone System,
   `twilio_connection` table). Supabase Auth cannot read that; the credentials must be entered
   here. The same Twilio account can be used. Supabase documents that Phone MFA "uses the same SMS
   provider configuration as phone login", so the provider is configured on the Phone provider
   page. Whether the dashboard also requires phone *sign-in* to be toggled on to save the
   credentials was not verified. If it does, the app still offers no phone sign-in, but the Auth API
   would accept phone OTP sign-ups: make sure phone sign-ups are not allowed (Authentication →
   Sign In / Providers → "Allow new users to sign up", or the Phone provider's own sign-up toggle).
2. **Phone MFA switched on.** Authentication → Multi-Factor → **Phone**: Enabled (enroll + verify).

Recommended while there: SMS OTP expiry ≥ 300 seconds (default 60s is tight for SMS delivery),
OTP length 6. The app's resend button waits 60 s, matching Supabase's default per-number send
frequency.

If Phone MFA is off, Supabase returns `mfa_phone_enroll_not_enabled`; the Security tab shows
"SMS verification is not enabled for this workspace yet…" and suggests the authenticator app.
If the provider is misconfigured, Supabase returns `sms_send_failed` and the modal says the text
could not be sent.

### 3. Deploy the admin function

`supabase/functions/admin-mfa-reset` is new. Deploy it with JWT verification **on** (it is
deliberately not listed in `supabase/config.toml`, so the CLI default `verify_jwt = true` applies):

```sh
supabase functions deploy admin-mfa-reset --project-ref <your-project-ref>
```

Until it is deployed, the Staff drawer shows "Status unavailable" in the two-factor card.

## Recovery

A user who lost every method asks an admin. The admin verifies the request out of band, then uses
**Reset Two-Factor** in the Staff drawer. Rules enforced server-side by `admin-mfa-reset`:
`staff.reset_password` permission (Admin, SuperAdmin), same org, target ranks below the caller
(SuperAdmin exempt), no self-reset, and an MFA-enrolled admin must themselves be at `aal2`. Each
reset is written to `audit_logs` (`action = 'mfa_reset'`). If the owner (SuperAdmin) loses every
method, delete the factor in the Supabase dashboard: Authentication → Users → user → MFA factors.

## Known limits

- **Enforcement is in the browser app and the admin function, not in RLS.** A stolen password
  still yields an `aal1` token that PostgREST/RLS and most edge functions accept. Closing that needs
  restrictive RLS policies of the "enforce only for users that have opted in" form from the Supabase
  MFA guide (`auth.jwt()->>'aal'` vs `auth.mfa_factors`) on the sensitive tables, plus an `aal`
  check in browser-facing edge functions. Agent service accounts have no factors, so that policy
  form leaves them unaffected.
- When an expired session is restored through the "Session Expired" modal with a password, the new
  session is `aal1`; MFA users are sent to `/login` to enter a code, then returned to the page.
