import { supabase } from '../lib/supabase';
import { ProposalReviewError, type ReviewFlag, flagKey, reviewProposalSections, unacknowledgedFlags } from '../../supabase/functions/_shared/proposal-review';
import type {
  Proposal,
  ProposalSignatureRequest,
  ProposalSignature,
  ProposalAuditEvent,
  ProposalSignatureStatus,
} from '../types';
import { generateProposalHTML } from './proposalPdfExport';
import { getBrandKits } from './brandboard';
import { advanceOpportunityToStageByName } from './opportunities';
import { APP_BASE_URL } from '../constants';

export async function computeDocumentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateSecureToken(): { raw: string; hash: Promise<string> } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { raw, hash: computeDocumentHash(raw) };
}

async function buildProposalSnapshot(proposalId: string) {
  const { data: proposal, error } = await supabase
    .from('proposals')
    .select(`
      *,
      contact:contacts(*),
      opportunity:opportunities(*),
      line_items:proposal_line_items(*, product:products(*)),
      sections:proposal_sections(*)
    `)
    .eq('id', proposalId)
    .single();

  if (error || !proposal) throw new Error('Proposal not found');

  let brandKit = null;
  try {
    const kits = await getBrandKits(proposal.org_id, { active: true });
    if (kits.length > 0) brandKit = kits[0];
  } catch {
    // continue without brand kit
  }

  const htmlSnapshot = generateProposalHTML(proposal as Proposal, brandKit);
  const jsonSnapshot = {
    title: proposal.title,
    total_value: proposal.total_value,
    currency: proposal.currency,
    summary: proposal.summary,
    valid_until: proposal.valid_until,
    brand: {
      primary: brandKit?.latest_version?.colors?.primary?.hex ?? null,
      logo: brandKit?.latest_version?.logos?.find((l) => l.url)?.url ?? null,
    },
    contact: proposal.contact
      ? {
          first_name: proposal.contact.first_name,
          last_name: proposal.contact.last_name,
          email: proposal.contact.email,
          company: proposal.contact.company,
          phone: proposal.contact.phone,
        }
      : null,
    sections: (proposal.sections || []).map((s: Record<string, unknown>) => ({
      title: s.title,
      content: s.content,
      section_type: s.section_type,
      sort_order: s.sort_order,
    })),
    line_items: (proposal.line_items || []).map((li: Record<string, unknown>) => ({
      name: li.name,
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unit_price,
      discount_percent: li.discount_percent,
      sort_order: li.sort_order,
    })),
  };

  const documentHash = await computeDocumentHash(htmlSnapshot);
  return { proposal, htmlSnapshot, jsonSnapshot, documentHash };
}

// Order-insensitive canonical form of the signable content, so two reads of the same rows compare equal.
// jsonb storage reorders object keys, so values are serialised with sorted keys.
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const canonicalContent = (snap: Record<string, unknown>): string => {
  const byJson = (xs: unknown) => [...((xs as unknown[]) ?? [])].map((x) => stableStringify(x)).sort();
  return stableStringify({ ...snap, sections: byJson(snap.sections), line_items: byJson(snap.line_items) });
};

/**
 * Once the proposal is locked for signature, prove the content that was frozen is still what the live rows hold:
 * an edit that slipped in between the freeze and the lock would otherwise leave a stale snapshot (the hash the
 * signer's page checks, and the archive of the signed document) behind. Compares the signable content (not the
 * rendered HTML, whose cover badge changes with the status). Throws if it changed.
 */
export async function assertSnapshotStillCurrent(proposalId: string): Promise<void> {
  // Compare against the STORED artifact, not an in-memory copy: a concurrent send can overwrite the stored snapshot
  // between this send's freeze and its lock, and the signer's hash and the signed PDF use what is stored.
  const { data: stored, error } = await supabase
    .from('proposals')
    .select('frozen_json_snapshot')
    .eq('id', proposalId)
    .maybeSingle();
  if (error) throw error;
  if (!stored?.frozen_json_snapshot) throw new Error('The proposal has no frozen snapshot to verify. Send it again.');
  const { jsonSnapshot } = await buildProposalSnapshot(proposalId);
  if (canonicalContent(jsonSnapshot) !== canonicalContent(stored.frozen_json_snapshot as Record<string, unknown>)) {
    throw new Error('The proposal changed while it was being sent. Review it and send it again.');
  }
}

export async function freezeProposal(
  proposalId: string,
  opts: { acknowledgedFlagKeys?: string[] } = {}
): Promise<{ htmlSnapshot: string; jsonSnapshot: Record<string, unknown>; documentHash: string }> {
  const { proposal, htmlSnapshot, jsonSnapshot, documentHash } = await buildProposalSnapshot(proposalId);

  // Money document: no unresolved NEEDS PRICING / CONFIRM SCOPE markers or a pricing table that does not add up,
  // unless a person has acknowledged the flags (the caller records that).
  const reviewFlags = reviewProposalSections(
    ((proposal.sections ?? []) as { title: string; content: string }[]).map((s) => ({ title: s.title, content: s.content }))
  );
  // An acknowledgment covers exactly the flags the person saw; anything introduced since is still blocking.
  const openFlags = unacknowledgedFlags(reviewFlags, opts.acknowledgedFlagKeys);
  if (openFlags.length > 0) throw new ProposalReviewError(openFlags);

  const { error: updateError } = await supabase
    .from('proposals')
    .update({
      frozen_html_snapshot: htmlSnapshot,
      frozen_json_snapshot: jsonSnapshot,
      frozen_document_hash: documentHash,
    })
    .eq('id', proposalId);

  if (updateError) throw updateError;

  return { htmlSnapshot, jsonSnapshot, documentHash };
}

/**
 * Re-review the live sections once the proposal is locked for signature (signature_status set), before anything is
 * emailed. Between freezeProposal and the lock another editor can still save a section; this catches a marker or an
 * arithmetic error introduced in that window. Throws ProposalReviewError for anything the person did not acknowledge.
 */
export async function assertSectionsStillReviewed(proposalId: string, acknowledgedFlagKeys: string[]): Promise<void> {
  const { data, error } = await supabase
    .from('proposal_sections')
    .select('title, content')
    .eq('proposal_id', proposalId);
  if (error) throw error;
  const open = unacknowledgedFlags(
    reviewProposalSections((data ?? []).map((s) => ({ title: String(s.title ?? ''), content: String(s.content ?? '') }))),
    acknowledgedFlagKeys
  );
  if (open.length > 0) throw new ProposalReviewError(open);
}

export async function createSignatureRequest(
  proposalId: string,
  contactId: string | null,
  signerName: string,
  signerEmail: string,
  expiresInDays: number,
  createdByUserId: string,
  orgId: string
): Promise<{ request: ProposalSignatureRequest; rawToken: string; signingUrl: string }> {
  const token = generateSecureToken();
  const tokenHash = await token.hash;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const { data: request, error } = await supabase
    .from('proposal_signature_requests')
    .insert({
      org_id: orgId,
      proposal_id: proposalId,
      contact_id: contactId,
      signer_name: signerName,
      signer_email: signerEmail,
      access_token_hash: tokenHash,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
      created_by_user_id: createdByUserId,
    })
    .select()
    .single();

  if (error) throw error;

  const { error: proposalError } = await supabase
    .from('proposals')
    .update({
      status: 'sent',
      signature_status: 'pending_signature' as ProposalSignatureStatus,
      expires_at: expiresAt.toISOString(),
      signature_request_id: request.id,
      signer_name: signerName,
      signer_email: signerEmail,
    })
    .eq('id', proposalId);

  if (proposalError) {
    // Never leave a live request attached to a proposal that could not be locked (e.g. a concurrent send won).
    const { error: voidError } = await supabase
      .from('proposal_signature_requests')
      .update({ status: 'voided' })
      .eq('id', request.id)
      .neq('status', 'signed');
    if (voidError) {
      // The request is still live and the one-live-request index will block a retry: say so, so it can be voided by hand.
      throw new Error(`Could not lock the proposal (${proposalError.message}) and could not void request ${request.id}: ${voidError.message}. Void it from the proposal page before sending again.`);
    }
    throw proposalError;
  }

  await createAuditEvent({
    proposalId,
    orgId,
    eventType: 'sent_for_signature',
    actorType: 'user',
    actorId: createdByUserId,
    metadata: {
      signer_name: signerName,
      signer_email: signerEmail,
      expires_at: expiresAt.toISOString(),
    },
  });

  const signingUrl = `${APP_BASE_URL}/sign/proposal/${request.id}?token=${encodeURIComponent(token.raw)}`;

  return { request, rawToken: token.raw, signingUrl };
}

export async function verifySigningToken(
  requestId: string,
  rawToken: string
): Promise<ProposalSignatureRequest | null> {
  const tokenHash = await computeDocumentHash(rawToken);

  const { data, error } = await supabase
    .from('proposal_signature_requests')
    .select('*')
    .eq('id', requestId)
    .eq('access_token_hash', tokenHash)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

export async function markRequestViewed(requestId: string, proposalId: string, orgId: string): Promise<void> {
  const { data: request } = await supabase
    .from('proposal_signature_requests')
    .select('viewed_at')
    .eq('id', requestId)
    .single();

  if (!request?.viewed_at) {
    await supabase
      .from('proposal_signature_requests')
      .update({ viewed_at: new Date().toISOString(), status: 'viewed' })
      .eq('id', requestId);

    await supabase
      .from('proposals')
      .update({ signature_status: 'viewed' as ProposalSignatureStatus })
      .eq('id', proposalId)
      .in('signature_status', ['pending_signature']);

    await createAuditEvent({
      proposalId,
      orgId,
      eventType: 'viewed',
      actorType: 'signer',
      metadata: { request_id: requestId },
    });
  }
}

export async function submitSignature(params: {
  requestId: string;
  proposalId: string;
  orgId: string;
  signatureType: 'typed' | 'drawn';
  signatureText?: string;
  signatureImageUrl?: string;
  signerName: string;
  signerEmail: string;
  ipAddress?: string;
  userAgent?: string;
  consentText: string;
  documentHash: string;
}): Promise<ProposalSignature> {
  const { data: signature, error } = await supabase
    .from('proposal_signatures')
    .insert({
      org_id: params.orgId,
      proposal_id: params.proposalId,
      signature_request_id: params.requestId,
      signature_type: params.signatureType,
      signature_text: params.signatureText || null,
      signature_image_url: params.signatureImageUrl || null,
      signer_name: params.signerName,
      signer_email: params.signerEmail,
      ip_address: params.ipAddress || null,
      user_agent: params.userAgent || null,
      consent_text: params.consentText,
      document_hash: params.documentHash,
    })
    .select()
    .single();

  if (error) throw error;

  const now = new Date().toISOString();

  await supabase
    .from('proposal_signature_requests')
    .update({ status: 'signed', signed_at: now })
    .eq('id', params.requestId);

  await supabase
    .from('proposals')
    .update({
      signature_status: 'signed' as ProposalSignatureStatus,
      signed_at: now,
      signer_name: params.signerName,
      signer_email: params.signerEmail,
    })
    .eq('id', params.proposalId);

  await createAuditEvent({
    proposalId: params.proposalId,
    orgId: params.orgId,
    eventType: 'signed',
    actorType: 'signer',
    metadata: {
      request_id: params.requestId,
      signature_id: signature.id,
      signer_name: params.signerName,
      signer_email: params.signerEmail,
      ip_address: params.ipAddress,
      user_agent: params.userAgent,
      document_hash: params.documentHash,
    },
  });

  try {
    const { data: proposal } = await supabase
      .from('proposals')
      .select('opportunity_id')
      .eq('id', params.proposalId)
      .maybeSingle();

    if (proposal?.opportunity_id) {
      await advanceOpportunityToStageByName(proposal.opportunity_id, 'Agreement Signed', null);
    }
  } catch (err) {
    console.error('Failed to advance opportunity stage on proposal signature:', err);
  }

  return signature;
}

export async function declineSignature(
  requestId: string,
  proposalId: string,
  orgId: string,
  reason?: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  const now = new Date().toISOString();

  await supabase
    .from('proposal_signature_requests')
    .update({
      status: 'declined',
      declined_at: now,
      decline_reason: reason || null,
    })
    .eq('id', requestId);

  await supabase
    .from('proposals')
    .update({
      signature_status: 'declined' as ProposalSignatureStatus,
      declined_at: now,
    })
    .eq('id', proposalId);

  await createAuditEvent({
    proposalId,
    orgId,
    eventType: 'declined',
    actorType: 'signer',
    metadata: {
      request_id: requestId,
      reason: reason || null,
      ip_address: ipAddress,
      user_agent: userAgent,
    },
  });
}

export async function voidSignatureRequest(
  requestId: string,
  proposalId: string,
  orgId: string,
  actorUserId: string
): Promise<void> {
  // Conditional on the request not being voided or signed: a signer finalizing at the same moment (the finalize RPC
  // locks the request row) must win. Zero matched rows means it was signed or already voided, so nothing changes.
  const { data: voided, error: voidError } = await supabase
    .from('proposal_signature_requests')
    .update({ status: 'voided' })
    .eq('id', requestId)
    .eq('proposal_id', proposalId)
    .not('status', 'in', '(voided,signed)')
    .select('id');
  if (voidError) throw voidError;
  if (!voided || voided.length === 0) {
    // Retry-safe: a previous attempt may have voided the request and failed before the proposal update. Continue
    // only in that exact case (request voided, proposal still pointing at it); never for a signed request.
    const { data: current, error: readError } = await supabase
      .from('proposal_signature_requests')
      .select('status, proposal_id')
      .eq('id', requestId)
      .maybeSingle();
    if (readError) throw readError;
    const { data: proposalNow, error: proposalReadError } = await supabase
      .from('proposals')
      .select('signature_status, signature_request_id')
      .eq('id', proposalId)
      .maybeSingle();
    if (proposalReadError) throw proposalReadError;
    const repairable = current?.status === 'voided'
      && current?.proposal_id === proposalId
      && (proposalNow?.signature_request_id === requestId || proposalNow?.signature_request_id == null)
      && proposalNow?.signature_status !== 'voided';
    if (!repairable) {
      throw new Error('This signature request was already signed or voided, so it cannot be voided.');
    }
  }

  // Only the proposal that still points at this request: a newer request's state is never overwritten.
  const { data: proposalVoided, error: proposalVoidError } = await supabase
    .from('proposals')
    .update({ signature_status: 'voided' as ProposalSignatureStatus })
    .eq('id', proposalId)
    .or(`signature_request_id.eq.${requestId},signature_request_id.is.null`)
    .select('id');
  if (proposalVoidError) throw proposalVoidError;
  if (!proposalVoided || proposalVoided.length === 0) {
    throw new Error('The proposal now belongs to a newer signature request, so it was not changed.');
  }

  await createAuditEvent({
    proposalId,
    orgId,
    eventType: 'voided',
    actorType: 'user',
    actorId: actorUserId,
    metadata: { request_id: requestId },
  });
}

/** Flag keys a person has already acknowledged for this proposal, drawn from the audit log. */
async function acknowledgedFlagKeys(proposalId: string): Promise<string[]> {
  const { data } = await supabase
    .from('proposal_audit_events')
    .select('metadata')
    .eq('proposal_id', proposalId)
    .eq('event_type', 'review_flags_acknowledged');
  const keys = new Set<string>();
  for (const row of data ?? []) {
    const flags = ((row.metadata as { flags?: ReviewFlag[] } | null)?.flags) ?? [];
    for (const f of flags) keys.add(flagKey(f));
  }
  return [...keys];
}

export async function resendSignatureRequest(
  requestId: string,
  proposalId: string,
  orgId: string,
  actorUserId: string
): Promise<{ rawToken: string; signingUrl: string }> {
  // A resend is a send, so it does not bypass the review gate. This is the authoritative check: it runs on
  // sections loaded fresh here (not a possibly-stale copy held by the caller). Flags a person already
  // acknowledged for this proposal (recorded in the audit log by the original send) stay cleared, so a
  // Retry Send after an email-delivery failure is not blocked on flags that were already reviewed; any
  // flag introduced since is still blocking.
  const { data: sections, error: sectionsError } = await supabase
    .from('proposal_sections')
    .select('title, content')
    .eq('proposal_id', proposalId)
    .order('sort_order', { ascending: true });
  if (sectionsError) throw sectionsError; // fail closed: never resend on a failed read
  const flags = reviewProposalSections(
    ((sections ?? []) as { title: string; content: string }[]).map((s) => ({ title: s.title, content: s.content }))
  );
  const ackKeys = flags.length > 0 ? await acknowledgedFlagKeys(proposalId) : [];
  if (flags.length > 0) {
    const openFlags = unacknowledgedFlags(flags, ackKeys);
    if (openFlags.length > 0) throw new ProposalReviewError(openFlags);
  }

  const token = generateSecureToken();
  const tokenHash = await token.hash;

  // Same rule as void: only rotate a request that is not signed or voided, and treat zero rows (a signer finalized in
  // between, or a concurrent send took the live-request slot) as a conflict rather than overwriting it.
  const { data: rotated, error: rotateError } = await supabase
    .from('proposal_signature_requests')
    .update({
      access_token_hash: tokenHash,
      viewed_at: null,
      status: 'pending',
    })
    .eq('id', requestId)
    .not('status', 'in', '(voided,signed)')
    .select('id');
  if (rotateError) throw rotateError;
  if (!rotated || rotated.length === 0) {
    throw new Error('This signature request changed while resending (it may have just been signed). Nothing was resent.');
  }

  const { error: relockError } = await supabase
    .from('proposals')
    .update({ status: 'sent', signature_status: 'pending_signature' as ProposalSignatureStatus })
    .eq('id', proposalId);
  if (relockError) {
    // The request was rotated but the proposal could not be re-locked: do not leave a live, unsent request behind.
    const { error: cleanupError } = await supabase
      .from('proposal_signature_requests')
      .update({ status: 'voided' })
      .eq('id', requestId)
      .not('status', 'in', '(voided,signed)');
    if (cleanupError) {
      // Still live and rotated, but its link was never sent: report the id so it can be voided by hand.
      throw new Error(`Could not re-lock the proposal (${relockError.message}) and could not void request ${requestId}: ${cleanupError.message}. Void it from the proposal page before sending again.`);
    }
    throw relockError;
  }

  // The proposal is locked again: re-review the live sections before the caller emails the new link, so a save that
  // landed between the read above and the lock cannot reach the signer unreviewed. On a finding, void the request
  // (which also makes the proposal editable) and report it.
  try {
    await assertSectionsStillReviewed(proposalId, ackKeys);
  } catch (recheckError) {
    await voidSignatureRequest(requestId, proposalId, orgId, actorUserId);
    throw recheckError;
  }

  await createAuditEvent({
    proposalId,
    orgId,
    eventType: 'resent',
    actorType: 'user',
    actorId: actorUserId,
    metadata: { request_id: requestId },
  });

  const signingUrl = `${APP_BASE_URL}/sign/proposal/${requestId}?token=${encodeURIComponent(token.raw)}`;

  return { rawToken: token.raw, signingUrl };
}

export async function getSignatureRequestByProposal(
  proposalId: string
): Promise<ProposalSignatureRequest | null> {
  const { data, error } = await supabase
    .from('proposal_signature_requests')
    .select('*')
    .eq('proposal_id', proposalId)
    .neq('status', 'voided')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data;
}

export async function getAuditEvents(proposalId: string): Promise<ProposalAuditEvent[]> {
  const { data, error } = await supabase
    .from('proposal_audit_events')
    .select('*')
    .eq('proposal_id', proposalId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function createAuditEvent(params: {
  proposalId: string;
  orgId: string;
  eventType: string;
  actorType: 'system' | 'user' | 'signer';
  actorId?: string;
  metadata?: Record<string, unknown>;
}): Promise<ProposalAuditEvent> {
  const { data, error } = await supabase
    .from('proposal_audit_events')
    .insert({
      org_id: params.orgId,
      proposal_id: params.proposalId,
      event_type: params.eventType,
      actor_type: params.actorType,
      actor_id: params.actorId || null,
      metadata: params.metadata || {},
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getProposalForSigning(
  proposalId: string
): Promise<Proposal | null> {
  const { data, error } = await supabase
    .from('proposals')
    .select(`
      *,
      contact:contacts(first_name, last_name, email, company, phone),
      line_items:proposal_line_items(name, description, quantity, unit_price, discount_percent, sort_order),
      sections:proposal_sections(title, content, section_type, sort_order)
    `)
    .eq('id', proposalId)
    .maybeSingle();

  if (error) return null;
  return data;
}

export async function uploadSignatureImage(
  orgId: string,
  requestId: string,
  imageDataUrl: string
): Promise<string | null> {
  try {
    const base64Data = imageDataUrl.split(',')[1];
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'image/png' });

    const path = `${orgId}/${requestId}/signature.png`;
    const { error: uploadError } = await supabase.storage
      .from('proposal-signatures')
      .upload(path, blob, { contentType: 'image/png', upsert: true });

    if (uploadError) return null;

    const { data: urlData } = supabase.storage
      .from('proposal-signatures')
      .getPublicUrl(path);

    return urlData.publicUrl;
  } catch {
    return null;
  }
}
