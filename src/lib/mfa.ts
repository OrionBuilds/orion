/**
 * Pure MFA helpers: assurance-level evaluation for the route guard, error mapping for the
 * enroll/challenge/verify flows, and small input validators. No Supabase client import here, so
 * everything in this file is unit-testable (src/lib/mfa.test.ts).
 *
 * Model (Supabase Auth native MFA):
 *  - currentLevel is the `aal` claim in the access token: aal1 after password/OAuth, aal2 after a
 *    successful mfa.verify().
 *  - nextLevel is aal2 as soon as the user has at least one VERIFIED factor, otherwise aal1.
 *  - A user with no verified factors (including the CLARA/FRIDAY agent service accounts) is
 *    aal1 -> aal1 and is never asked for a second factor.
 */

export type AuthenticatorAssuranceLevel = 'aal1' | 'aal2' | 'aal3' | string | null;

export interface AalSnapshot {
  currentLevel: AuthenticatorAssuranceLevel;
  nextLevel: AuthenticatorAssuranceLevel;
}

/**
 * - unknown:   not evaluated yet for the current session (treated as "still loading").
 * - satisfied: no second factor needed (no verified factors, or already at aal2).
 * - required:  the user has a verified factor but this session is below aal2.
 * - error:     the level could not be determined. Fails closed: the guard sends the user to the
 *              challenge screen, which offers retry and sign-out.
 */
export type MfaStatus = 'unknown' | 'satisfied' | 'required' | 'error';

export function requiresMfaChallenge(aal: AalSnapshot | null | undefined): boolean {
  if (!aal) return false;
  return aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2';
}

export function evaluateMfaStatus(
  data: AalSnapshot | null | undefined,
  error: unknown,
): MfaStatus {
  if (error || !data) return 'error';
  return requiresMfaChallenge(data) ? 'required' : 'satisfied';
}

export type RouteAccess = 'loading' | 'login' | 'mfa' | 'allow';

export interface RouteAccessInput {
  isLoading: boolean;
  hasSession: boolean;
  hasUser: boolean;
  mfaStatus: MfaStatus;
  /** OAuth implicit-flow tokens still sitting in the URL hash. */
  oauthTokensInHash?: boolean;
}

/**
 * The single decision ProtectedRoute makes before its permission / feature-flag checks.
 * Order matters: no session -> login; session but the AAL is not settled -> loading; a second
 * factor outstanding (or undeterminable) -> mfa; then the existing "session but user row not
 * loaded yet" spinner; then allow.
 */
export function resolveRouteAccess(input: RouteAccessInput): RouteAccess {
  if (input.isLoading || input.oauthTokensInHash) return 'loading';
  if (!input.hasSession) return 'login';
  if (input.mfaStatus === 'unknown') return 'loading';
  if (input.mfaStatus === 'required' || input.mfaStatus === 'error') return 'mfa';
  if (!input.hasUser) return 'loading';
  return 'allow';
}

// ---------------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------------

export const PHONE_MFA_DISABLED_MESSAGE =
  'SMS verification is not enabled for this workspace yet. An administrator needs to turn on ' +
  'Phone MFA and connect an SMS provider in the Supabase Auth settings. You can add an ' +
  'authenticator app instead.';

export const TOTP_MFA_DISABLED_MESSAGE =
  'Authenticator app verification is not enabled for this workspace. An administrator needs to ' +
  'turn on TOTP MFA in the Supabase Auth settings.';

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as ErrorLike).code === 'string') {
    return (err as ErrorLike).code as string;
  }
  return '';
}

function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as ErrorLike).message === 'string') {
    return (err as ErrorLike).message as string;
  }
  return '';
}

/** True when the error says phone (SMS) MFA is switched off at the Supabase Auth level. */
export function isPhoneMfaDisabledError(err: unknown): boolean {
  const code = errorCode(err);
  if (code === 'mfa_phone_enroll_not_enabled' || code === 'mfa_phone_verify_not_enabled') return true;
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('phone') && (msg.includes('disabled') || msg.includes('not enabled'));
}

export function describeMfaError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (isPhoneMfaDisabledError(err)) return PHONE_MFA_DISABLED_MESSAGE;

  switch (errorCode(err)) {
    case 'mfa_totp_enroll_not_enabled':
    case 'mfa_totp_verify_not_enabled':
      return TOTP_MFA_DISABLED_MESSAGE;
    case 'mfa_verification_failed':
    case 'mfa_verification_rejected':
      return 'That code is incorrect or has expired. Check it and try again.';
    case 'mfa_challenge_expired':
      return 'This code has expired. Request a new one and try again.';
    case 'mfa_factor_not_found':
      return 'That verification method no longer exists. Refresh the page and try again.';
    case 'mfa_factor_name_conflict':
      return 'You already have a method with that name. Choose a different name.';
    case 'too_many_enrolled_mfa_factors':
      return 'You have reached the maximum number of verification methods. Remove one first.';
    case 'mfa_verified_factor_exists':
      return 'This phone number is already set up as a verification method.';
    case 'mfa_ip_address_mismatch':
      return 'Verification has to finish from the same network it started on. Request a new code.';
    case 'insufficient_aal':
      return 'Confirm a code from one of your existing verification methods first.';
    case 'sms_send_failed':
      return 'The text message could not be sent. Check the number, or ask an administrator to check the SMS provider settings.';
    case 'over_sms_send_rate_limit':
      return 'Too many texts were sent. Wait a minute before requesting another code.';
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a minute and try again.';
    case 'validation_failed':
      return errorMessage(err) || fallback;
    default:
      break;
  }

  const msg = errorMessage(err);
  if (/invalid.*(code|totp|otp)/i.test(msg)) {
    return 'That code is incorrect or has expired. Check it and try again.';
  }
  if (/phone/i.test(msg) && /invalid/i.test(msg)) {
    return 'Enter the phone number in international format, for example +15551234567.';
  }
  return msg || fallback;
}

// ---------------------------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------------------------

export type MfaFactorType = 'totp' | 'phone';

/** Keep digits only; TOTP is always 6 digits, SMS codes 6-10 (Supabase otp_length, default 6). */
export function sanitizeOtp(input: string, maxLength = 10): string {
  return input.replace(/\D/g, '').slice(0, maxLength);
}

export function isValidOtp(code: string, factorType: MfaFactorType): boolean {
  return factorType === 'totp' ? /^\d{6}$/.test(code) : /^\d{6,10}$/.test(code);
}

/**
 * Normalise a phone number to E.164 (what Supabase phone factors require). A bare 10-digit number
 * is assumed to be US/Canada. Returns null when the result is not a plausible E.164 number.
 */
export function normalizePhoneE164(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  let e164: string;
  if (hasPlus) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else e164 = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** "+15551234567" -> "+1 •••• 4567". Leaves short / missing values readable. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  const last4 = digits.slice(-4);
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  return `${cc ? `+${cc} ` : ''}•••• ${last4}`;
}

// Matches the Supabase Auth default SMS max frequency (60s per number); a shorter UI cooldown just
// produces over_sms_send_rate_limit errors.
export const SMS_RESEND_COOLDOWN_SECONDS = 60;

export function secondsUntilResend(
  lastSentAt: number | null,
  now: number,
  cooldownSeconds = SMS_RESEND_COOLDOWN_SECONDS,
): number {
  if (lastSentAt === null) return 0;
  const remainingMs = lastSentAt + cooldownSeconds * 1000 - now;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}
