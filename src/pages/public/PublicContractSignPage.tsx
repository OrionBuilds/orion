import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import { SignatureCapture } from '../../components/proposals/SignatureCapture';
import { uploadContractSignatureImage } from '../../services/contractSigning';
import type { Contract, ContractSignatureRequest } from '../../types';
import {
  Scale,
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
  MapPin,
  Calendar,
} from 'lucide-react';
import { formatCurrency, formatDateLong } from '../../utils/formatters';

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CONTRACT_TYPE_LABELS: Record<string, string> = {
  freelance_service: 'Freelance Service Agreement',
  retainer: 'Retainer Agreement',
  partnership: 'Partnership Agreement',
  nda: 'Non-Disclosure Agreement',
};

type PageState = 'loading' | 'invalid' | 'expired' | 'already_signed' | 'declined' | 'voided' | 'ready' | 'signing' | 'signed' | 'decline_form';

export function PublicContractSignPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [pageState, setPageState] = useState<PageState>('loading');
  const [request, setRequest] = useState<ContractSignatureRequest | null>(null);
  const [contract, setContract] = useState<Contract | null>(null);
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

      // One token-scoped call replaces a direct read of the request AND of the contract. Both
      // tables' anon SELECT policies were token-blind — contracts was `public_token IS NOT NULL`,
      // and contract_signature_requests was USING (true), which exposed every signer's name, email
      // and token hash to anyone holding the anon key. The RPC requires the request-id + token-hash
      // pair carried by the signing link, and never returns the hash back out.
      const { data: rpcResult, error: contractError } = await supabase
        .rpc('public_get_contract_for_signing', {
          p_request_id: requestId,
          p_token_hash: tokenHash,
        });

      const payload = rpcResult as {
        ok?: boolean; error?: string; contract?: Contract; request?: ContractSignatureRequest;
      } | null;

      if (contractError || !payload?.ok || !payload.contract || !payload.request) {
        // Expiry, void and decline are decided server-side now — a client-side expiry check is a
        // courtesy, not a control, since the RPC is reachable directly. Honour what it reports
        // rather than flattening everything to "invalid".
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
      const contractData = payload.contract;
      setRequest(req);

      // 'signed' is not an error — the document exists and the page shows the already-signed view.
      if (req.status === 'signed') { setPageState('already_signed'); return; }

      setContract(contractData);

      if (!req.viewed_at) {
        // Was three separate anon writes, one of which never worked: there is no anon UPDATE policy
        // on `contracts`, so `signature_status = 'viewed'` silently affected zero rows and
        // view-tracking on the contract itself has never functioned. The RPC does all three under
        // one token check, and only stamps viewed_at on the first open so the original timestamp
        // stays intact as evidence.
        await supabase.rpc('public_mark_contract_signature_viewed', {
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
    if (!request || !contract || !signatureData || !consentChecked) return;

    try {
      setIsSubmitting(true);
      setError(null);
      setPageState('signing');

      let signatureImageUrl: string | null = null;
      if (signatureData.imageDataUrl) {
        // Was an inline copy of this upload that discarded the error and then called getPublicUrl()
        // unconditionally. getPublicUrl only builds a string — it never checks the object exists —
        // so every failed upload still wrote a confident-looking URL to the signature row. The
        // result: 3 of 3 signatures in production pointed at storage objects that return NoSuchKey,
        // including a DRAWN signature where the image is the only record of the mark made.
        // uploadContractSignatureImage returns null on failure, so a broken upload now leaves the
        // column null and the certificate says "Not recorded" instead of lying.
        signatureImageUrl = await uploadContractSignatureImage(
          contract.org_id,
          request.id,
          signatureData.imageDataUrl,
        );
      }

      const documentHash = contract.frozen_html_snapshot
        ? await hashToken(contract.frozen_html_snapshot)
        : 'no-snapshot';

      const consentText = `I, ${request.signer_name}, agree to electronically sign this contract. I understand this constitutes a legally binding signature.`;

      if (!token) {
        throw new Error('Signing token is missing from the URL');
      }
      const tokenHash = await hashToken(token);

      // Call the atomic RPC that:
      // 1. Verifies the token
      // 2. Inserts the signature
      // 3. Updates the signature request
      // 4. Updates the contract (fires handle_contract_signed trigger -> opp -> Closed Won + Kickoff project)
      // 5. Records the audit event
      // Runs with SECURITY DEFINER to bypass RLS safely.
      const { error: rpcError } = await supabase.rpc(
        'public_finalize_contract_signature',
        {
          p_request_id: request.id,
          p_token_hash: tokenHash,
          p_signer_name: request.signer_name,
          p_signer_email: request.signer_email,
          p_signature_type: signatureData.type,
          p_signature_text: signatureData.text || null,
          p_signature_image_url: signatureImageUrl,
          // Deliberately null: the browser cannot see its own public IP and a client-supplied one
          // would be forgeable. A BEFORE INSERT trigger on contract_signatures overwrites this from
          // the request headers, so what lands in the row is server-observed, not self-reported.
          p_ip_address: null,
          p_user_agent: navigator.userAgent,
          p_consent_text: consentText,
          p_document_hash: documentHash,
        }
      );

      if (rpcError) throw rpcError;

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
    if (!request || !contract) return;

    try {
      setIsSubmitting(true);
      setError(null);

      if (!token) { setError('This signing link is missing its token.'); return; }

      // Was three anon writes with no token check between them, and the middle one never worked:
      // `contracts` has no anon UPDATE policy, so a declined contract kept its previous status
      // while only the request row recorded the decline. One token-scoped call now does all three,
      // and refuses if the request was already signed or voided.
      const { data: declineResult, error: declineError } = await supabase
        .rpc('public_decline_contract_signature', {
          p_request_id: request.id,
          p_token_hash: await hashToken(token),
          p_reason: declineReason || null,
        });

      const declined = declineResult as { ok?: boolean; error?: string } | null;
      if (declineError || !declined?.ok) {
        setError(
          declined?.error === 'signed' ? 'This contract has already been signed.'
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
          <p className="text-hud-cream-dim">This signing link is invalid or has been revoked. Please contact the sender for a new link.</p>
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
          <p className="text-hud-cream-dim">This signing request has expired. Please contact the sender to request a new link.</p>
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
          <p className="text-hud-cream-dim">This contract has already been signed. No further action is needed.</p>
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
          <h1 className="text-2xl font-bold text-white mb-2">Contract Signed</h1>
          <p className="text-hud-cream-dim mb-6">Your signature has been recorded. The sender has been notified.</p>
          <div className="p-4 bg-hud-bg-card/60 rounded-lg border border-hud-bg-elev">
            <p className="text-sm text-hud-cream-soft">A signed copy of this contract will be available from the sender. You can safely close this page.</p>
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
          <h1 className="text-xl font-semibold text-white mb-2">Contract Declined</h1>
          <p className="text-hud-cream-dim">The sender has been notified of your decision.</p>
        </div>
      </div>
    );
  }

  const sections = [...(contract?.sections || [])].sort((a, b) => a.sort_order - b.sort_order);
  const typeLabel = CONTRACT_TYPE_LABELS[contract?.contract_type || ''] || contract?.contract_type || '';

  return (
    <div className="min-h-dvh bg-hud-bg-deep" ref={topRef}>
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 bg-hud-gold/20 rounded-lg flex items-center justify-center">
            <Scale className="w-5 h-5 text-hud-gold-soft" />
          </div>
          <div>
            <p className="text-sm text-hud-cream-dim">Contract for your review</p>
            <h1 className="text-xl font-bold text-white">{contract?.title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-3 text-sm text-hud-cream-mute mt-2 mb-4">
          <span>{typeLabel}</span>
          {contract?.effective_date && (
            <span className="flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              Effective {formatDateLong(contract.effective_date, { fallback: '' })}
            </span>
          )}
          {contract?.governing_law_state && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5" />
              {contract.governing_law_state}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mb-8">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-hud-rust/20 text-hud-rust/40 rounded-full text-sm font-medium">
            <PenTool className="w-3.5 h-3.5" />
            Signature Requested
          </span>
          {request?.expires_at && (
            <span className="text-sm text-hud-cream-dim">Expires {formatDateLong(request.expires_at, { fallback: '' })}</span>
          )}
        </div>

        {error && (
          <div className="mb-6 p-4 bg-hud-plum/10 border border-hud-plum/30 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0 mt-0.5" />
            <p className="text-sm text-hud-plum/40">{error}</p>
          </div>
        )}

        {(contract?.party_a_name || contract?.party_b_name) && (
          <div className="grid grid-cols-2 gap-4 mb-6 p-5 bg-hud-bg-mid rounded-xl border border-hud-bg-card">
            <div>
              <h3 className="text-xs font-semibold text-hud-gold-soft uppercase tracking-wider mb-2">Party A</h3>
              <p className="text-sm text-white font-medium">{contract.party_a_name || 'Not specified'}</p>
              {contract.party_a_email && <p className="text-xs text-hud-cream-dim mt-1">{contract.party_a_email}</p>}
            </div>
            <div>
              <h3 className="text-xs font-semibold text-hud-gold-soft uppercase tracking-wider mb-2">Party B</h3>
              <p className="text-sm text-white font-medium">
                {contract.party_b_name || (contract.contact ? `${contract.contact.first_name} ${contract.contact.last_name}` : 'Not specified')}
              </p>
              {(contract.party_b_email || contract.contact?.email) && (
                <p className="text-xs text-hud-cream-dim mt-1">{contract.party_b_email || contract.contact?.email}</p>
              )}
            </div>
          </div>
        )}

        {contract && contract.total_value > 0 && (
          <div className="mb-6 p-5 bg-hud-bg-mid rounded-xl border border-hud-bg-card">
            <div className="flex items-center justify-between">
              <span className="text-hud-cream-dim text-sm">Contract Value</span>
              <span className="text-2xl font-bold text-hud-gold-soft flex items-center gap-1">
                <DollarSign className="w-5 h-5" />
                {formatCurrency(contract.total_value, contract.currency).replace('$', '')}
              </span>
            </div>
          </div>
        )}

        {sections.length > 0 && (
          <div className="space-y-3 mb-6">
            {sections.map((section) => (
              <div key={section.id} className="bg-hud-bg-mid rounded-xl border border-hud-bg-card overflow-hidden">
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
                    {section.annotation && (
                      <div className="mb-3 px-3 py-2 bg-hud-bg-card/50 border-l-2 border-hud-gold/50 rounded-r-md">
                        <p className="text-xs text-hud-cream-dim italic">{section.annotation}</p>
                      </div>
                    )}
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

        {pageState === 'decline_form' ? (
          <div className="bg-hud-bg-mid rounded-xl border border-hud-plum/30 p-6 mb-6">
            <h3 className="text-lg font-semibold text-white mb-4">Decline This Contract</h3>
            <p className="text-sm text-hud-cream-dim mb-4">Please let the sender know why you are declining. This is optional.</p>
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
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
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
                <h3 className="text-lg font-semibold text-white">Sign This Contract</h3>
                <p className="text-sm text-hud-cream-dim">By signing, you agree to the terms outlined above</p>
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
                I agree to electronically sign this contract. I understand this constitutes a
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
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenTool className="w-4 h-4" />}
                Sign Contract
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
