import { supabase } from '../lib/supabase';
import { sendEmail, getEmailSetupStatus } from './emailSend';
import { getEmailDefaults } from './emailDefaults';
import { buildSignatureRequestEmail } from './proposalSigningEmails';

export interface SignatureEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  blockingReasons?: string[];
}

export interface SignatureEmailParams {
  proposalTitle: string;
  totalValue?: string;
  signerName: string;
  signerEmail: string;
  signingUrl: string;
  expiresAt: string;
  orgId: string;
  companyName: string;
}

async function resolveFromAddress(orgId: string): Promise<{ id: string; email: string } | null> {
  try {
    const defaults = await getEmailDefaults(orgId);
    if (defaults?.default_from_address?.id) {
      return { id: defaults.default_from_address.id, email: defaults.default_from_address.email };
    }
  } catch {
    // fall through to fallback
  }

  const { data: fallback } = await supabase
    .from('email_from_addresses')
    .select('id, email')
    .eq('org_id', orgId)
    .eq('active', true)
    .order('is_default', { ascending: false })
    .limit(1)
    .maybeSingle();

  return fallback || null;
}

export async function validateEmailSetup(orgId: string): Promise<{
  ready: boolean;
  fromAddress: { id: string; email: string } | null;
  blockingReasons: string[];
}> {
  try {
    const status = await getEmailSetupStatus();
    if (!status.isConfigured) {
      return { ready: false, fromAddress: null, blockingReasons: status.blockingReasons || [] };
    }
  } catch {
    return { ready: false, fromAddress: null, blockingReasons: ['Unable to check email configuration'] };
  }

  const fromAddress = await resolveFromAddress(orgId);
  if (!fromAddress) {
    return {
      ready: false,
      fromAddress: null,
      blockingReasons: ['No Resend sender is configured for e-signature delivery.'],
    };
  }

  return { ready: true, fromAddress, blockingReasons: [] };
}

export async function sendSignatureRequestEmail(
  params: SignatureEmailParams
): Promise<SignatureEmailResult> {
  const { ready, fromAddress, blockingReasons } = await validateEmailSetup(params.orgId);
  if (!ready || !fromAddress) {
    return { success: false, error: blockingReasons[0] || 'Email not configured', blockingReasons };
  }

  const htmlBody = buildSignatureRequestEmail({
    signerName: params.signerName,
    proposalTitle: params.proposalTitle,
    totalValue: params.totalValue,
    signingUrl: params.signingUrl,
    expiresAt: params.expiresAt,
    companyName: params.companyName,
  });

  const result = await sendEmail({
    toEmail: params.signerEmail,
    toName: params.signerName,
    fromAddressId: fromAddress.id,
    subject: `Please review and sign: ${params.proposalTitle}`,
    htmlBody,
    trackOpens: true,
    trackClicks: false,
    transactional: true,
  });

  return result;
}

/** Which signature queue the id belongs to. Proposals and contracts have separate tables. */
export type SignatureRequestKind = 'proposal' | 'contract';

/**
 * Record the send outcome against a signature request.
 *
 * THE BUG THIS FIXES. This wrote to `proposal_signature_requests` unconditionally, and the CONTRACT
 * send modal calls it with a `contract_signature_requests` id. PostgREST reports no error when an
 * update matches zero rows, so the write silently did nothing: on 2026-08-03 a contract signature
 * email was genuinely sent through Resend and its request row still read
 * `send_status: 'pending', last_sent_at: null` forever. The Signature tab showed "Pending" for a
 * message that had already gone out, and the reminder scheduler — which keys off send_status —
 * could never see it either.
 *
 * The two tables also disagree on the message-id column (`provider_message_id` vs the legacy
 * `sendgrid_message_id`, left over from before the Resend migration), so the column is mapped too.
 *
 * A zero-row update is now reported rather than swallowed. It cannot be an exception: by the time
 * this runs the email has ALREADY been sent, and throwing would make the caller tell the owner the
 * send failed — a worse lie than the one being fixed.
 */
export async function updateSignatureRequestSendStatus(
  requestId: string,
  status: 'sent' | 'failed',
  messageId?: string,
  error?: string,
  kind: SignatureRequestKind = 'proposal'
): Promise<{ ok: boolean; error?: string }> {
  const table = kind === 'contract' ? 'contract_signature_requests' : 'proposal_signature_requests';
  const messageIdColumn = kind === 'contract' ? 'sendgrid_message_id' : 'provider_message_id';

  const patch: Record<string, unknown> = {
    send_status: status,
    [messageIdColumn]: messageId || null,
    send_error: status === 'failed' ? (error || 'Unknown error') : null,
  };
  if (status === 'sent') patch.last_sent_at = new Date().toISOString();

  // `.select('id')` so a zero-row match is visible. Without it this call is indistinguishable from
  // a successful one, which is exactly how the contract bug survived.
  const { data, error: updateError } = await supabase
    .from(table)
    .update(patch)
    .eq('id', requestId)
    .select('id');

  if (updateError) {
    console.error(`[signature] failed to record send status on ${table}/${requestId}:`, updateError.message);
    return { ok: false, error: updateError.message };
  }
  if (!data || data.length === 0) {
    const msg = `no ${table} row matched id ${requestId} — the email was sent but its status was not recorded`;
    console.error(`[signature] ${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: true };
}
