import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import { SignatureCapture } from '../../components/proposals/SignatureCapture';
import type { Proposal, ProposalSignatureRequest } from '../../types';
import {
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  PenTool,
  ChevronDown,
  ChevronUp,
  DollarSign,
} from 'lucide-react';
import { formatCurrency, formatDateLong } from '../../utils/formatters';

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashContent(content: string): Promise<string> {
  return hashToken(content);
}

type PageState = 'loading' | 'invalid' | 'expired' | 'already_signed' | 'declined' | 'voided' | 'ready' | 'signing' | 'signed' | 'decline_form';

export function PublicProposalSignPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [pageState, setPageState] = useState<PageState>('loading');
  const [request, setRequest] = useState<ProposalSignatureRequest | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const [signatureData, setSignatureData] = useState<{
    type: 'typed' | 'drawn';
    text?: string;
    imageDataUrl?: string;
  } | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    verifyAndLoad();
  }, [requestId, token]);

  const verifyAndLoad = async () => {
    if (!requestId || !token) {
      setPageState('invalid');
      return;
    }

    try {
      const tokenHash = await hashToken(token);

      // One token-scoped call replaces direct reads of BOTH the request and the proposal.
      //
      // This fixes public proposal signing, which has never worked: proposals, proposal_sections and
      // proposal_line_items have only authenticated org-scoped policies — no anon SELECT at all — so
      // the read below always came back empty and every visitor saw "invalid". 4 of 5 proposals sent
      // for signature expired unsigned, and 0 signatures were ever recorded.
      const { data: rpcResult, error: rpcError } = await supabase
        .rpc('public_get_proposal_for_signing', {
          p_request_id: requestId,
          p_token_hash: tokenHash,
        });

      const payload = rpcResult as {
        ok?: boolean; error?: string; proposal?: Proposal; request?: ProposalSignatureRequest;
      } | null;

      if (rpcError || !payload?.ok || !payload.proposal || !payload.request) {
        const reason = payload?.error;
        setPageState(
          reason === 'expired' ? 'expired'
          : reason === 'voided' ? 'voided'
          : reason === 'declined' ? 'declined'
          : 'invalid',
        );
        return;
      }

      const req = payload.request;

      setRequest(req);

      if (req.status === 'signed') {
        setPageState('already_signed');
        return;
      }
      // declined / voided / expired are decided server-side by the RPC above and handled there —
      // a client-side expiry check is a courtesy, not a control, since the RPC is reachable directly.

      const proposalData = payload.proposal;
      setProposal(proposalData);

      if (!req.viewed_at) {
        // Three anon writes became one token-checked call. The middle one never worked — `proposals`
        // has no anon UPDATE policy, so marking it viewed silently affected zero rows.
        await supabase.rpc('public_mark_proposal_signature_viewed', {
          p_request_id: requestId,
          p_token_hash: tokenHash,
        });
      }

      setPageState('ready');
    } catch (err) {
      console.error('Verification failed:', err);
      setPageState('invalid');
    }
  };

  const handleSign = async () => {
    if (!request || !proposal || !signatureData || !consentChecked) return;

    try {
      setIsSubmitting(true);
      setError(null);
      setPageState('signing');

      let signatureImageUrl: string | null = null;
      if (signatureData.imageDataUrl) {
        // The upload error used to be discarded, then getPublicUrl() — which only builds a string
        // and never checks the object exists — wrote a URL regardless. Every signature bucket in
        // production is empty while the rows all carry URLs, because of exactly this. Record the
        // URL only when the bytes actually landed.
        const base64Data = signatureData.imageDataUrl.split(',')[1];
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'image/png' });

        const path = `${proposal.org_id}/${request.id}/signature.png`;
        const { error: uploadError } = await supabase.storage
          .from('proposal-signatures')
          .upload(path, blob, { contentType: 'image/png', upsert: true });

        if (uploadError) {
          // Not fatal: a typed signature still stands on the name, consent text and hash. Losing
          // the image must not lose the signature, but it must not be reported as present either.
          console.error('Signature image upload failed:', uploadError.message);
        } else {
          const { data: urlData } = supabase.storage
            .from('proposal-signatures')
            .getPublicUrl(path);
          signatureImageUrl = urlData.publicUrl;
        }
      }

      const documentHash = proposal.frozen_html_snapshot
        ? await hashContent(proposal.frozen_html_snapshot)
        : 'no-snapshot';

      const consentText = `I, ${request.signer_name}, agree to electronically sign this proposal. I understand this constitutes a legally binding signature.`;

      if (!token) throw new Error('This signing link is missing its token.');

      // Four separate anon writes became one token-checked call, mirroring what contracts already
      // had in public_finalize_contract_signature. Two of those writes never worked: `proposals` has
      // no anon UPDATE policy, so marking it signed silently affected zero rows. The RPC also
      // refuses to re-sign an already-signed request, which the client-side path could not enforce.
      //
      // ip_address is deliberately not passed. A browser cannot see its own public IP and a
      // client-supplied one would be forgeable — worthless as dispute evidence. The BEFORE INSERT
      // trigger on proposal_signatures stamps it from the request headers instead.
      const { data: finalizeResult, error: sigError } = await supabase
        .rpc('public_finalize_proposal_signature', {
          p_request_id: request.id,
          p_token_hash: await hashToken(token),
          p_signature_type: signatureData.type,
          p_signature_text: signatureData.text || null,
          p_signature_image_url: signatureImageUrl,
          p_user_agent: navigator.userAgent,
          p_consent_text: consentText,
          p_document_hash: documentHash,
        });

      if (sigError) throw sigError;
      const finalized = finalizeResult as { ok?: boolean; error?: string } | null;
      if (!finalized?.ok) {
        throw new Error(
          finalized?.error === 'invalid_token' ? 'This signing link is no longer valid.'
          : finalized?.error === 'expired' ? 'This signing link has expired.'
          : finalized?.error === 'signed' ? 'This proposal has already been signed.'
          : 'Failed to submit signature',
        );
      }

      setPageState('signed');
      topRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error('Signing failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to submit signature');
      setPageState('ready');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDecline = async () => {
    if (!request || !proposal) return;

    try {
      setIsSubmitting(true);
      setError(null);

      if (!token) { setError('This signing link is missing its token.'); return; }

      // Three anon writes became one token-checked call; the `proposals` update among them never
      // worked, so a declined proposal kept its previous status while only the request recorded it.
      const { data: declineResult, error: declineError } = await supabase
        .rpc('public_decline_proposal_signature', {
          p_request_id: request.id,
          p_token_hash: await hashToken(token),
          p_reason: declineReason || null,
        });

      const declined = declineResult as { ok?: boolean; error?: string } | null;
      if (declineError || !declined?.ok) {
        setError(
          declined?.error === 'signed' ? 'This proposal has already been signed.'
          : declined?.error === 'voided' ? 'This signing request has been voided.'
          : declineError?.message ?? 'Failed to decline',
        );
        return;
      }

      setPageState('declined');
      topRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error('Decline failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to decline');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (pageState === 'loading') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-hud-gold-soft animate-spin mx-auto mb-4" />
          <p className="text-hud-cream-soft">Verifying your signing link...</p>
        </div>
      </div>
    );
  }

  if (pageState === 'invalid') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-hud-bg-mid rounded-2xl border border-hud-bg-card p-8 text-center">
          <div className="w-16 h-16 bg-hud-plum/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-hud-plum" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Invalid Signing Link</h1>
          <p className="text-hud-cream-dim">
            This signing link is invalid or has been revoked. Please contact the sender for a new link.
          </p>
        </div>
      </div>
    );
  }

  if (pageState === 'expired') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-hud-bg-mid rounded-2xl border border-hud-bg-card p-8 text-center">
          <div className="w-16 h-16 bg-hud-rust/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <Clock className="w-8 h-8 text-hud-rust" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Signing Link Expired</h1>
          <p className="text-hud-cream-dim">
            This signing request has expired. Please contact the sender to request a new link.
          </p>
        </div>
      </div>
    );
  }

  if (pageState === 'already_signed') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-hud-bg-mid rounded-2xl border border-hud-bg-card p-8 text-center">
          <div className="w-16 h-16 bg-hud-emerald/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-hud-emerald" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Already Signed</h1>
          <p className="text-hud-cream-dim">This proposal has already been signed. No further action is needed.</p>
        </div>
      </div>
    );
  }

  if (pageState === 'voided') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-hud-bg-mid rounded-2xl border border-hud-bg-card p-8 text-center">
          <div className="w-16 h-16 bg-hud-cream-mute/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <XCircle className="w-8 h-8 text-hud-cream-dim" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Signing Request Voided</h1>
          <p className="text-hud-cream-dim">This signing request has been voided by the sender.</p>
        </div>
      </div>
    );
  }

  if (pageState === 'signed') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4" ref={topRef}>
        <div className="max-w-md w-full bg-hud-bg-mid rounded-2xl border border-hud-emerald/30 p-8 text-center">
          <div className="w-20 h-20 bg-hud-emerald/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-hud-emerald" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Proposal Signed</h1>
          <p className="text-hud-cream-dim mb-6">
            Your signature has been recorded. The sender has been notified.
          </p>
          <div className="p-4 bg-hud-bg-card/60 rounded-lg border border-hud-bg-elev">
            <p className="text-sm text-hud-cream-soft">
              A signed copy of this proposal will be available from the sender.
              You can safely close this page.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (pageState === 'declined') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4" ref={topRef}>
        <div className="max-w-md w-full bg-hud-bg-mid rounded-2xl border border-hud-bg-card p-8 text-center">
          <div className="w-16 h-16 bg-hud-plum/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <XCircle className="w-8 h-8 text-hud-plum" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Proposal Declined</h1>
          <p className="text-hud-cream-dim">The sender has been notified of your decision.</p>
        </div>
      </div>
    );
  }

  const sections = [...(proposal?.sections || [])].sort((a, b) => a.sort_order - b.sort_order);
  const lineItems = [...(proposal?.line_items || [])].sort((a, b) => a.sort_order - b.sort_order);
  const nonPricingSections = sections.filter((s) => s.section_type !== 'pricing');

  return (
    <div className="min-h-dvh bg-hud-bg-deep" ref={topRef}>
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 bg-hud-gold/20 rounded-lg flex items-center justify-center">
            <FileText className="w-5 h-5 text-hud-gold-soft" />
          </div>
          <div>
            <p className="text-sm text-hud-cream-dim">Proposal for your review</p>
            <h1 className="text-xl font-bold text-white">{proposal?.title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4 mb-8">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-hud-rust/20 text-hud-rust/40 rounded-full text-sm font-medium">
            <PenTool className="w-3.5 h-3.5" />
            Signature Requested
          </span>
          {request?.expires_at && (
            <span className="text-sm text-hud-cream-dim">
              Expires {formatDateLong(request.expires_at, { fallback: '' })}
            </span>
          )}
        </div>

        {error && (
          <div className="mb-6 p-4 bg-hud-plum/10 border border-hud-plum/30 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0 mt-0.5" />
            <p className="text-sm text-hud-plum/40">{error}</p>
          </div>
        )}

        {proposal && proposal.total_value > 0 && (
          <div className="mb-6 p-5 bg-hud-bg-mid rounded-xl border border-hud-bg-card">
            <div className="flex items-center justify-between">
              <span className="text-hud-cream-dim text-sm">Total Value</span>
              <span className="text-2xl font-bold text-hud-gold-soft flex items-center gap-1">
                <DollarSign className="w-5 h-5" />
                {formatCurrency(proposal.total_value, proposal.currency).replace('$', '')}
              </span>
            </div>
          </div>
        )}

        {nonPricingSections.length > 0 && (
          <div className="space-y-3 mb-6">
            {nonPricingSections.map((section) => (
              <div
                key={section.id}
                className="bg-hud-bg-mid rounded-xl border border-hud-bg-card overflow-hidden"
              >
                <button
                  onClick={() => toggleSection(section.id)}
                  className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-hud-bg-card/50 transition-colors"
                >
                  <h3 className="font-medium text-white">{section.title}</h3>
                  {expandedSections.has(section.id) ? (
                    <ChevronUp className="w-5 h-5 text-hud-cream-dim" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-hud-cream-dim" />
                  )}
                </button>
                {expandedSections.has(section.id) && (
                  <div className="px-5 pb-5">
                    <div
                      className="prose prose-invert prose-sm max-w-none text-hud-cream-soft"
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(section.content) }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {lineItems.length > 0 && (
          <div className="mb-6 bg-hud-bg-mid rounded-xl border border-hud-bg-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hud-bg-card">
              <h3 className="font-medium text-white flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-hud-gold-soft" />
                Pricing
              </h3>
            </div>
            <div className="divide-y divide-hud-bg-card">
              {lineItems.map((item, idx) => {
                const lineTotal = item.quantity * item.unit_price;
                const discount = lineTotal * (item.discount_percent / 100);
                const total = lineTotal - discount;
                return (
                  <div key={idx} className="px-5 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-white text-sm">{item.name}</p>
                      {item.description && (
                        <p className="text-xs text-hud-cream-dim">{item.description}</p>
                      )}
                    </div>
                    <p className="text-white font-medium text-sm">
                      {formatCurrency(total, proposal?.currency)}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-4 border-t border-hud-bg-elev flex items-center justify-between bg-hud-bg-card/40">
              <span className="font-semibold text-white">Total</span>
              <span className="text-lg font-bold text-hud-gold-soft">
                {formatCurrency(proposal?.total_value || 0, proposal?.currency)}
              </span>
            </div>
          </div>
        )}

        {pageState === 'decline_form' ? (
          <div className="bg-hud-bg-mid rounded-xl border border-hud-plum/30 p-6 mb-6">
            <h3 className="text-lg font-semibold text-white mb-4">Decline This Proposal</h3>
            <p className="text-sm text-hud-cream-dim mb-4">
              Please let the sender know why you are declining. This is optional.
            </p>
            <textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="Reason for declining (optional)"
              rows={3}
              className="w-full px-4 py-3 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-mute resize-none focus:outline-none focus:ring-2 focus:ring-hud-plum/50 mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => setPageState('ready')}
                disabled={isSubmitting}
                className="flex-1 px-4 py-2.5 text-hud-cream-soft hover:text-white border border-hud-bg-elev rounded-lg transition-colors"
              >
                Go Back
              </button>
              <button
                onClick={handleDecline}
                disabled={isSubmitting}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-hud-plum hover:bg-hud-plum disabled:bg-hud-bg-elev text-white rounded-lg transition-colors"
              >
                {isSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <XCircle className="w-4 h-4" />
                )}
                Confirm Decline
              </button>
            </div>
          </div>
        ) : pageState === 'signing' ? (
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-8 text-center mb-6">
            <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin mx-auto mb-4" />
            <p className="text-hud-cream-soft">Recording your signature...</p>
          </div>
        ) : (
          <div className="bg-hud-bg-mid rounded-xl border border-hud-gold/30 p-6 mb-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-hud-gold/20 rounded-lg flex items-center justify-center">
                <PenTool className="w-5 h-5 text-hud-gold-soft" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Sign This Proposal</h3>
                <p className="text-sm text-hud-cream-dim">
                  By signing, you agree to the terms outlined above
                </p>
              </div>
            </div>

            <div className="mb-6">
              <SignatureCapture
                signerName={request?.signer_name || ''}
                onSignatureChange={setSignatureData}
              />
            </div>

            <label className="flex items-start gap-3 mb-6 cursor-pointer">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-1 w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold/50"
              />
              <span className="text-sm text-hud-cream-soft">
                I agree to electronically sign this proposal. I understand this constitutes a
                legally binding signature and that the document content has been presented to
                me in full.
              </span>
            </label>

            <div className="flex gap-3">
              <button
                onClick={() => setPageState('decline_form')}
                disabled={isSubmitting}
                className="px-5 py-2.5 text-hud-plum hover:text-hud-plum/40 border border-hud-plum/30 hover:border-hud-plum/50 rounded-lg transition-colors"
              >
                Decline
              </button>
              <button
                onClick={handleSign}
                disabled={!signatureData || !consentChecked || isSubmitting}
                className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep font-medium rounded-lg transition-colors"
              >
                {isSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <PenTool className="w-4 h-4" />
                )}
                Sign Proposal
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-center gap-2 text-hud-cream-mute text-xs mt-8">
          <Shield className="w-3.5 h-3.5" />
          <span>Secured by Orion OS. Your signature is encrypted and tamper-evident.</span>
        </div>
      </div>
    </div>
  );
}
