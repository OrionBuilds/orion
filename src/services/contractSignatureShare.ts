/**
 * Contract signature sharing — resend the email, or send the signing link by SMS.
 *
 * WHY THIS EXISTS. A contract went out to a client, Resend reported it DELIVERED, and the client
 * never found it — his firm's gateway had filed it. The OS had no second route: the Signature tab's
 * only action was a "Resend" button that rotated the token, copied the link to the clipboard, and
 * toasted "Resent." It sent nothing. The one thing its label promised was the one thing it did not
 * do, which is the same false-completion this codebase keeps having to remove.
 *
 * So there are now three honest actions, and each says exactly what it did:
 *   - resendContractSignatureEmail  — actually sends, and records the send against the contract row
 *   - sendContractSigningLinkBySms  — a second channel, because email deliverability is not a thing
 *                                     you control and a text usually lands when a filtered email
 *                                     does not
 *   - regenerateContractSigningLink — issues a link to share by hand, and says so
 *
 * EVERY ONE OF THESE ROTATES THE TOKEN. That is not a choice: only the SHA-256 hash of the signing
 * token is stored, never the token itself, so an existing link cannot be re-read — it can only be
 * replaced. The consequence is real and callers must surface it: issuing a new link kills the
 * previous one, so a client who later digs the original email out of spam will find a dead link.
 */

import { supabase } from '../lib/supabase';
import { resendContractSignatureRequest } from './contractSigning';
import { sendSignatureRequestEmail, updateSignatureRequestSendStatus } from './proposalSignatureEmail';
import { createContractActivity } from './contracts';
import type { Contract, ContractSignatureRequest } from '../types';
import { formatCurrency } from '../utils/formatters';
import { reportBackgroundError } from '../lib/errors';

export interface ContractShareContext {
  contract: Pick<Contract, 'id' | 'org_id' | 'title' | 'total_value' | 'currency' | 'contact_id'>;
  request: Pick<ContractSignatureRequest, 'id' | 'signer_name' | 'signer_email' | 'expires_at'>;
  actorUserId: string;
  companyName: string;
}

export interface ShareResult {
  ok: boolean;
  /** Always returned when a link was minted, even on a send failure — so the UI can still offer it. */
  signingUrl?: string;
  error?: string;
}

function money(amount: number, currency = 'USD'): string | undefined {
  if (!amount || amount <= 0) return undefined;
  return formatCurrency(amount, currency);
}

/**
 * Mint a fresh signing link. Sends nothing.
 *
 * For "I'll send this myself" — which is the right move when a client's mail gateway is eating
 * automated mail, since a person-to-person email from a domain they already correspond with is not
 * subject to the same filtering.
 */
export async function regenerateContractSigningLink(ctx: ContractShareContext): Promise<ShareResult> {
  try {
    const { signingUrl } = await resendContractSignatureRequest(
      ctx.request.id, ctx.contract.id, ctx.contract.org_id, ctx.actorUserId,
    );
    await createContractActivity(
      ctx.contract.org_id, ctx.contract.id, 'signature_link_generated',
      `New signing link generated for ${ctx.request.signer_name} (shared manually)`,
      ctx.actorUserId,
      // email_sent is explicit so the activity feed cannot be misread as a send.
      { signer_email: ctx.request.signer_email, email_sent: false, sms_sent: false },
    ).catch(reportBackgroundError('contractSignatureShare.regenerateContractSigningLink.createContractActivity'));
    return { ok: true, signingUrl };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not generate a signing link' };
  }
}

/** Resend the signature request email. Rotates the token, sends, and records the outcome. */
export async function resendContractSignatureEmail(ctx: ContractShareContext): Promise<ShareResult> {
  let signingUrl: string;
  try {
    const out = await resendContractSignatureRequest(
      ctx.request.id, ctx.contract.id, ctx.contract.org_id, ctx.actorUserId,
    );
    signingUrl = out.signingUrl;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not prepare the signing link' };
  }

  const result = await sendSignatureRequestEmail({
    proposalTitle: ctx.contract.title,
    totalValue: money(ctx.contract.total_value, ctx.contract.currency),
    signerName: ctx.request.signer_name,
    signerEmail: ctx.request.signer_email,
    signingUrl,
    expiresAt: ctx.request.expires_at,
    orgId: ctx.contract.org_id,
    companyName: ctx.companyName,
  });

  if (!result.success) {
    // The link is still valid and still worth handing back — a failed send does not mean the
    // owner is stuck, it means he should send it himself.
    return { ok: false, signingUrl, error: result.error || 'Email send failed' };
  }

  // 'contract' — this id belongs to contract_signature_requests. Omitting it wrote to the PROPOSAL
  // table, matched zero rows, and silently left the contract reading "Pending" after a real send.
  const recorded = await updateSignatureRequestSendStatus(
    ctx.request.id, 'sent', result.messageId, undefined, 'contract',
  );

  await createContractActivity(
    ctx.contract.org_id, ctx.contract.id, 'signature_sent',
    `Signature request re-sent to ${ctx.request.signer_email}`,
    ctx.actorUserId,
    {
      signer_email: ctx.request.signer_email,
      provider_message_id: result.messageId,
      resend: true,
      ...(recorded.ok ? {} : { send_status_record_failed: recorded.error }),
    },
  ).catch(reportBackgroundError('contractSignatureShare.resendContractSignatureEmail.createContractActivity'));

  return { ok: true, signingUrl };
}

export interface DeliveryStatus {
  /** "found" = Resend knows the message; "not_sent"/"no_request" are real states, not errors. */
  status: 'found' | 'not_sent' | 'no_request';
  /** Resend's verdict: delivered | bounced | complained | sent | queued … Null = accepted, no event yet. */
  lastEvent: string | null;
  signerEmail?: string | null;
  lastSentAt?: string | null;
}

/**
 * What Resend says happened to the signature email for this contract.
 *
 * Deliberately takes a CONTRACT id, not a message id: the edge function resolves the message id
 * server-side and refuses if the contract belongs to another org. Resend ids are global to the
 * account, so letting the browser name one would leak other orgs' recipients and subjects.
 *
 * Returns null when the answer is unknown — a lookup failure must not render as a delivery state.
 */
export async function getContractEmailDeliveryStatus(contractId: string): Promise<DeliveryStatus | null> {
  try {
    const { data, error } = await supabase.functions.invoke('email-delivery-status', {
      body: { contractId },
    });
    if (error || !data?.ok) return null;
    return {
      status: data.status,
      lastEvent: data.lastEvent ?? null,
      signerEmail: data.signerEmail ?? null,
      lastSentAt: data.lastSentAt ?? null,
    };
  } catch {
    return null;
  }
}

/** Digits only, with a leading + preserved — Twilio wants E.164. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  // A bare 10-digit number is US/Canada in this estate's context; 11 starting with 1 is the same
  // number already carrying its country code.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

/**
 * Text the signing link to the client.
 *
 * The second route that did not exist. Deliverability of automated email is not something the
 * sender controls; SMS is a different rail with a different failure mode, and when a gateway has
 * quietly filed a contract, a text is usually what gets it signed.
 */
export async function sendContractSigningLinkBySms(
  ctx: ContractShareContext,
  toNumberRaw: string,
): Promise<ShareResult> {
  const toNumber = normalizePhone(toNumberRaw);
  if (!toNumber || toNumber.replace(/\D/g, '').length < 10) {
    return { ok: false, error: 'That does not look like a valid phone number — nothing was sent.' };
  }

  let signingUrl: string;
  try {
    const out = await resendContractSignatureRequest(
      ctx.request.id, ctx.contract.id, ctx.contract.org_id, ctx.actorUserId,
    );
    signingUrl = out.signingUrl;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not prepare the signing link' };
  }

  const body =
    `${ctx.companyName}: here's the agreement "${ctx.contract.title}" for your signature. ` +
    `Sign here: ${signingUrl}`;

  try {
    const { data, error } = await supabase.functions.invoke('twilio-sms-send', {
      body: {
        orgId: ctx.contract.org_id,
        toNumber,
        body,
        contactId: ctx.contract.contact_id ?? null,
        metadata: {
          source: 'contract_signature_share',
          contract_id: ctx.contract.id,
          signature_request_id: ctx.request.id,
        },
      },
    });

    // Two distinct failures with one symptom. `error` is the invoke failing; `data.ok === false` is
    // Twilio rejecting the message. Reporting only the first is how a rejected send reads as a
    // delivered one.
    //
    // supabase-js turns ANY non-2xx into a FunctionsHttpError whose message is the useless
    // "Edge Function returned a non-2xx status code" — and twilio-sms-send answers 502 with the
    // real reason in the BODY. Left alone, the owner sees a status code instead of "no from-number
    // is configured", which is the difference between a fixable problem and a mystery.
    if (error) {
      let detail = '';
      try {
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          const parsed = await ctx.json();
          detail = parsed?.error || parsed?.message || '';
        }
      } catch { /* body already consumed or not JSON — fall back to the generic message */ }
      return { ok: false, signingUrl, error: detail || error.message || 'Could not reach the SMS service' };
    }
    if (!data?.ok) return { ok: false, signingUrl, error: data?.error || 'Twilio rejected the message' };

    await createContractActivity(
      ctx.contract.org_id, ctx.contract.id, 'signature_link_sms',
      `Signing link texted to ${toNumber}`,
      ctx.actorUserId,
      { to_number: toNumber, sid: data.sid ?? null, signer_name: ctx.request.signer_name },
    ).catch(reportBackgroundError('contractSignatureShare.sendContractSigningLinkBySms.createContractActivity'));

    return { ok: true, signingUrl };
  } catch (e) {
    return { ok: false, signingUrl, error: e instanceof Error ? e.message : 'SMS send failed' };
  }
}
