import type { Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';
import type { MfaFactorType } from '../lib/mfa';

/**
 * Thin wrappers over Supabase Auth native MFA (supabase.auth.mfa.*) for the signed-in user, plus
 * the admin reset call. Every function throws the Supabase AuthError unchanged so callers can map
 * it with describeMfaError() (which reads error.code).
 */

export interface MfaFactor {
  id: string;
  factorType: MfaFactorType;
  friendlyName: string;
  status: 'verified' | 'unverified';
  createdAt: string;
  /** E.164 number for phone factors (GoTrue returns it on the factor; not in the TS type). */
  phone?: string;
}

function toMfaFactor(f: Factor): MfaFactor | null {
  if (f.factor_type !== 'totp' && f.factor_type !== 'phone') return null;
  return {
    id: f.id,
    factorType: f.factor_type,
    friendlyName: f.friendly_name || (f.factor_type === 'totp' ? 'Authenticator app' : 'SMS'),
    status: f.status === 'verified' ? 'verified' : 'unverified',
    createdAt: f.created_at,
    phone: (f as Factor & { phone?: string }).phone || undefined,
  };
}

/** All TOTP / phone factors on the account (verified and unverified). Fresh from the server. */
export async function listMfaFactors(): Promise<MfaFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return (data?.all ?? []).map(toMfaFactor).filter((f): f is MfaFactor => f !== null);
}

export async function listVerifiedMfaFactors(): Promise<MfaFactor[]> {
  return (await listMfaFactors()).filter((f) => f.status === 'verified');
}

/**
 * Remove abandoned, never-verified factors of one type before a new enrollment, so a half-finished
 * earlier attempt can't cause a friendly-name conflict or count towards the factor limit.
 * Unverified factors can be removed at aal1.
 */
async function clearUnverified(factorType: MfaFactorType): Promise<void> {
  const factors = await listMfaFactors();
  for (const f of factors) {
    if (f.status === 'unverified' && f.factorType === factorType) {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
  }
}

export interface TotpEnrollment {
  factorId: string;
  /** SVG data URL of the QR code, safe to use as an <img src>. */
  qrCode: string;
  secret: string;
  uri: string;
}

export async function enrollTotp(friendlyName: string): Promise<TotpEnrollment> {
  await clearUnverified('totp');
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName,
    issuer: 'Orion OS',
  });
  if (error) throw error;
  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
    uri: data.totp.uri,
  };
}

export async function enrollPhone(phone: string, friendlyName: string): Promise<{ factorId: string }> {
  await clearUnverified('phone');
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'phone',
    phone,
    friendlyName,
  });
  if (error) throw error;
  return { factorId: data.id };
}

/** Starts a challenge. For a phone factor this sends the SMS. Returns the challenge id. */
export async function startChallenge(factorId: string, factorType: MfaFactorType): Promise<string> {
  const { data, error } =
    factorType === 'phone'
      ? await supabase.auth.mfa.challenge({ factorId, channel: 'sms' })
      : await supabase.auth.mfa.challenge({ factorId });
  if (error) throw error;
  return data.id;
}

/**
 * Verifies a code. On success Supabase replaces the session with an aal2 one and emits
 * MFA_CHALLENGE_VERIFIED (AuthContext listens for it). Verifying an unverified factor also marks
 * it verified, which is how enrollment completes.
 */
export async function verifyChallenge(factorId: string, challengeId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.verify({ factorId, challengeId, code });
  if (error) throw error;
}

export async function challengeAndVerifyTotp(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw error;
}

/** Removing a verified factor requires an aal2 session; the UI re-verifies right before this. */
export async function unenrollFactor(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

/** Best effort: drop a pending enrollment the user cancelled. */
export async function discardPendingFactor(factorId: string): Promise<void> {
  try {
    await supabase.auth.mfa.unenroll({ factorId });
  } catch {
    // Unverified leftovers are also cleared by the next enrollment of the same type.
  }
}

// ---------------------------------------------------------------------------------------------
// Admin recovery (Staff Management) -> edge function admin-mfa-reset (service role)
// ---------------------------------------------------------------------------------------------

export interface AdminMfaFactorSummary {
  id: string;
  factor_type: string;
  friendly_name: string | null;
  status: string;
  created_at: string;
  phone_masked: string | null;
}

async function callAdminMfa<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const res = await callEdgeFunction('admin-mfa-reset', body);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parseEdgeFunctionError(json, fallback));
  return json as T;
}

export async function adminGetUserMfaStatus(userId: string): Promise<AdminMfaFactorSummary[]> {
  const json = await callAdminMfa<{ factors: AdminMfaFactorSummary[] }>(
    { action: 'status', userId },
    'Failed to load two-factor status',
  );
  return json.factors ?? [];
}

export async function adminResetUserMfa(userId: string): Promise<{ removed: number }> {
  return callAdminMfa<{ removed: number }>(
    { action: 'reset', userId },
    'Failed to reset two-factor authentication',
  );
}
