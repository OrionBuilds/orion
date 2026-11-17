import { describe, it, expect } from 'vitest';
import {
  requiresMfaChallenge,
  evaluateMfaStatus,
  resolveRouteAccess,
  isPhoneMfaDisabledError,
  describeMfaError,
  PHONE_MFA_DISABLED_MESSAGE,
  TOTP_MFA_DISABLED_MESSAGE,
  sanitizeOtp,
  isValidOtp,
  normalizePhoneE164,
  maskPhone,
  secondsUntilResend,
  type RouteAccessInput,
} from './mfa';

describe('requiresMfaChallenge', () => {
  it('requires a challenge when the user has verified factors but the session is aal1', () => {
    expect(requiresMfaChallenge({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe(true);
  });

  it('treats a token without an aal claim as below aal2', () => {
    expect(requiresMfaChallenge({ currentLevel: null, nextLevel: 'aal2' })).toBe(true);
  });

  it('does not require a challenge once the session is aal2', () => {
    expect(requiresMfaChallenge({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe(false);
  });

  it('does not require a challenge for users with no verified factors (agent service accounts)', () => {
    expect(requiresMfaChallenge({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe(false);
  });

  it('does not require a challenge after the last factor is removed from an aal2 session', () => {
    expect(requiresMfaChallenge({ currentLevel: 'aal2', nextLevel: 'aal1' })).toBe(false);
  });

  it('is false for a missing snapshot', () => {
    expect(requiresMfaChallenge(null)).toBe(false);
    expect(requiresMfaChallenge(undefined)).toBe(false);
  });
});

describe('evaluateMfaStatus', () => {
  it('returns required for aal1 -> aal2', () => {
    expect(evaluateMfaStatus({ currentLevel: 'aal1', nextLevel: 'aal2' }, null)).toBe('required');
  });

  it('returns satisfied for aal1 -> aal1 and aal2 -> aal2', () => {
    expect(evaluateMfaStatus({ currentLevel: 'aal1', nextLevel: 'aal1' }, null)).toBe('satisfied');
    expect(evaluateMfaStatus({ currentLevel: 'aal2', nextLevel: 'aal2' }, null)).toBe('satisfied');
  });

  it('fails closed to error when the level cannot be determined', () => {
    expect(evaluateMfaStatus(null, new Error('network'))).toBe('error');
    expect(evaluateMfaStatus(null, null)).toBe('error');
    expect(evaluateMfaStatus({ currentLevel: 'aal2', nextLevel: 'aal2' }, { message: 'boom' })).toBe('error');
  });
});

describe('resolveRouteAccess', () => {
  const base: RouteAccessInput = {
    isLoading: false,
    hasSession: true,
    hasUser: true,
    mfaStatus: 'satisfied',
    oauthTokensInHash: false,
  };

  it('allows a fully authenticated user with no outstanding factor', () => {
    expect(resolveRouteAccess(base)).toBe('allow');
  });

  it('waits while auth is loading or OAuth tokens are still in the hash', () => {
    expect(resolveRouteAccess({ ...base, isLoading: true })).toBe('loading');
    expect(resolveRouteAccess({ ...base, oauthTokensInHash: true })).toBe('loading');
  });

  it('sends a visitor without a session to login, whatever the MFA status', () => {
    expect(resolveRouteAccess({ ...base, hasSession: false, hasUser: false, mfaStatus: 'unknown' })).toBe('login');
    expect(resolveRouteAccess({ ...base, hasSession: false, mfaStatus: 'required' })).toBe('login');
  });

  it('waits while the assurance level has not been evaluated for the session', () => {
    expect(resolveRouteAccess({ ...base, mfaStatus: 'unknown' })).toBe('loading');
  });

  it('sends an aal1 session with verified factors to the MFA challenge', () => {
    expect(resolveRouteAccess({ ...base, mfaStatus: 'required' })).toBe('mfa');
  });

  it('gates on MFA before the user row has loaded, so app data is not shown first', () => {
    expect(resolveRouteAccess({ ...base, hasUser: false, mfaStatus: 'required' })).toBe('mfa');
  });

  it('fails closed to the MFA screen when the level could not be determined', () => {
    expect(resolveRouteAccess({ ...base, mfaStatus: 'error' })).toBe('mfa');
  });

  it('keeps the existing spinner for a session whose user row is still loading', () => {
    expect(resolveRouteAccess({ ...base, hasUser: false })).toBe('loading');
  });

  it('survives a reload: restored aal2 session is allowed, restored aal1 session is challenged', () => {
    const afterReload = { ...base, isLoading: false };
    expect(resolveRouteAccess({ ...afterReload, mfaStatus: evaluateMfaStatus({ currentLevel: 'aal2', nextLevel: 'aal2' }, null) })).toBe('allow');
    expect(resolveRouteAccess({ ...afterReload, mfaStatus: evaluateMfaStatus({ currentLevel: 'aal1', nextLevel: 'aal2' }, null) })).toBe('mfa');
  });

  it('never challenges an account without factors (agent service accounts)', () => {
    const status = evaluateMfaStatus({ currentLevel: 'aal1', nextLevel: 'aal1' }, null);
    expect(resolveRouteAccess({ ...base, mfaStatus: status })).toBe('allow');
  });
});

describe('MFA error mapping', () => {
  it('detects phone MFA disabled by error code', () => {
    expect(isPhoneMfaDisabledError({ code: 'mfa_phone_enroll_not_enabled', message: 'x' })).toBe(true);
    expect(isPhoneMfaDisabledError({ code: 'mfa_phone_verify_not_enabled', message: 'x' })).toBe(true);
    expect(describeMfaError({ code: 'mfa_phone_enroll_not_enabled' })).toBe(PHONE_MFA_DISABLED_MESSAGE);
  });

  it('detects phone MFA disabled by message when no code is present', () => {
    expect(isPhoneMfaDisabledError({ message: 'MFA enroll is disabled for Phone' })).toBe(true);
    expect(isPhoneMfaDisabledError(new Error('Phone MFA is not enabled'))).toBe(true);
  });

  it('does not misreport unrelated errors as phone MFA disabled', () => {
    expect(isPhoneMfaDisabledError({ code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' })).toBe(false);
    expect(isPhoneMfaDisabledError(null)).toBe(false);
  });

  it('maps TOTP disabled, bad code, expiry and rate limits to readable messages', () => {
    expect(describeMfaError({ code: 'mfa_totp_enroll_not_enabled' })).toBe(TOTP_MFA_DISABLED_MESSAGE);
    expect(describeMfaError({ code: 'mfa_verification_failed' })).toMatch(/incorrect/);
    expect(describeMfaError({ code: 'mfa_challenge_expired' })).toMatch(/expired/);
    expect(describeMfaError({ code: 'over_sms_send_rate_limit' })).toMatch(/Wait/);
    expect(describeMfaError({ code: 'sms_send_failed' })).toMatch(/could not be sent/);
  });

  it('falls back to the raw message, then to the fallback', () => {
    expect(describeMfaError({ message: 'Something odd' })).toBe('Something odd');
    expect(describeMfaError({}, 'Fallback')).toBe('Fallback');
  });
});

describe('input helpers', () => {
  it('sanitizes OTP input to digits', () => {
    expect(sanitizeOtp('12 34-56')).toBe('123456');
    expect(sanitizeOtp('1234567890123')).toBe('1234567890');
    expect(sanitizeOtp('123456789', 6)).toBe('123456');
  });

  it('validates OTP length per factor type', () => {
    expect(isValidOtp('123456', 'totp')).toBe(true);
    expect(isValidOtp('12345', 'totp')).toBe(false);
    expect(isValidOtp('1234567', 'totp')).toBe(false);
    expect(isValidOtp('123456', 'phone')).toBe(true);
    expect(isValidOtp('12345678', 'phone')).toBe(true);
    expect(isValidOtp('12345', 'phone')).toBe(false);
  });

  it('normalizes phone numbers to E.164', () => {
    expect(normalizePhoneE164('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhoneE164('1 555 123 4567')).toBe('+15551234567');
    expect(normalizePhoneE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhoneE164('12345')).toBeNull();
    expect(normalizePhoneE164('')).toBeNull();
    expect(normalizePhoneE164('+0123456789')).toBeNull();
  });

  it('masks phone numbers', () => {
    expect(maskPhone('+15551234567')).toBe('+1 •••• 4567');
    expect(maskPhone('15551234567')).toBe('+1 •••• 4567');
    expect(maskPhone(undefined)).toBe('');
  });

  it('computes the SMS resend cooldown', () => {
    expect(secondsUntilResend(null, 1000)).toBe(0);
    expect(secondsUntilResend(0, 0, 30)).toBe(30);
    expect(secondsUntilResend(0, 29_001, 30)).toBe(1);
    expect(secondsUntilResend(0, 30_000, 30)).toBe(0);
  });
});
