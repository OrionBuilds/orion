import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { freezeContract, createContractSignatureRequest, createContractAuditEvent } from '../../services/contractSigning';
import { createContractActivity } from '../../services/contracts';
import {
  validateEmailSetup,
  sendSignatureRequestEmail,
  updateSignatureRequestSendStatus,
} from '../../services/proposalSignatureEmail';
import { buildSignatureRequestEmail } from '../../services/proposalSigningEmails';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import type { Contract } from '../../types';
import {
  X, PenTool, Loader2, AlertCircle, Calendar, Mail, User,
  ArrowLeft, Eye, Send, AlertTriangle,
} from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import { Portal } from '../shared/Portal';

interface Props {
  contract: Contract;
  onClose: () => void;
  onSent: () => void;
}

type ModalStep = 'form' | 'preview' | 'freezing' | 'sending';

export function SendContractForSignatureModal({ contract, onClose, onSent }: Props) {
  const { user } = useAuth();
  const contactName = contract.contact
    ? `${contract.contact.first_name || ''} ${contract.contact.last_name || ''}`.trim()
    : contract.party_b_name || '';

  const [signerName, setSignerName] = useState(contactName);
  const [signerEmail, setSignerEmail] = useState(contract.contact?.email || contract.party_b_email || '');
  const [expirationDays, setExpirationDays] = useState(14);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<ModalStep>('form');
  const [emailReady, setEmailReady] = useState<boolean | null>(null);
  const [senderEmail, setSenderEmail] = useState<string | null>(null);
  const [emailBlockingReasons, setEmailBlockingReasons] = useState<string[]>([]);

  const expiresAt = useMemo(
    () => new Date(Date.now() + expirationDays * 86400000).toISOString(),
    [expirationDays]
  );

  const companyName = user?.organization?.name || 'Our Company';

  const previewHtml = useMemo(() => {
    if (!signerName.trim() || !contract.title) return '';
    return buildSignatureRequestEmail({
      signerName: signerName.trim(),
      proposalTitle: contract.title,
      totalValue: contract.total_value > 0
        ? formatCurrency(contract.total_value, contract.currency)
        : undefined,
      signingUrl: '#',
      expiresAt,
      companyName,
    });
  }, [signerName, contract.title, contract.total_value, contract.currency, expiresAt, companyName]);

  const canProceed =
    signerName.trim() &&
    signerEmail.trim() &&
    expirationDays > 0 &&
    contract.title &&
    (contract.sections?.length || 0) > 0;

  useEffect(() => {
    let cancelled = false;
    validateEmailSetup(contract.org_id).then((result) => {
      if (cancelled) return;
      setEmailReady(result.ready);
      setSenderEmail(result.fromAddress?.email || null);
      setEmailBlockingReasons(result.blockingReasons);
    });
    return () => { cancelled = true; };
  }, [contract.org_id]);

  const handlePreview = () => {
    if (!canProceed) return;
    setError(null);
    setStep('preview');
  };

  const handleSend = async () => {
    if (!user || !canProceed) return;

    try {
      setIsSending(true);
      setError(null);
      setStep('freezing');

      await freezeContract(contract.id);

      setStep('sending');

      const { request, signingUrl } = await createContractSignatureRequest(
        contract.id,
        contract.contact_id,
        signerName.trim(),
        signerEmail.trim(),
        expirationDays,
        user.id,
        contract.org_id
      );

      const emailResult = await sendSignatureRequestEmail({
        proposalTitle: contract.title,
        totalValue: contract.total_value > 0
          ? formatCurrency(contract.total_value, contract.currency)
          : undefined,
        signerName: signerName.trim(),
        signerEmail: signerEmail.trim(),
        signingUrl,
        expiresAt,
        orgId: contract.org_id,
        companyName,
      });

      if (emailResult.success) {
        // 'contract' — this id belongs to contract_signature_requests. Omitting it wrote to the
        // PROPOSAL table, matched nothing, and left every contract stuck showing "Pending" after a
        // successful send.
        const recorded = await updateSignatureRequestSendStatus(
          request.id, 'sent', emailResult.messageId, undefined, 'contract'
        );

        await createContractActivity(
          contract.org_id,
          contract.id,
          'signature_sent',
          `Signature request sent to ${signerEmail.trim()}`,
          user.id,
          {
            signer_name: signerName.trim(),
            signer_email: signerEmail.trim(),
            provider_message_id: emailResult.messageId,
            sender_email: senderEmail,
            // Carried so a status write that failed leaves a trace on the activity itself. The
            // email is out either way; this stops the UI's "Pending" from being the only clue.
            ...(recorded.ok ? {} : { send_status_record_failed: recorded.error }),
          }
        );

        onSent();
      } else {
        await createContractAuditEvent({
          contractId: contract.id,
          orgId: contract.org_id,
          eventType: 'signature_send_failed',
          actorType: 'system',
          metadata: {
            error: emailResult.error,
            signer_email: signerEmail.trim(),
            request_id: request.id,
          },
        });

        setError(emailResult.error || 'Failed to send signature request email. You can retry from the Signature tab.');
        setStep('form');
      }
    } catch (err) {
      console.error('Failed to send for signature:', err);
      setError(err instanceof Error ? err.message : 'Failed to send signature request');
      setStep('form');
    } finally {
      setIsSending(false);
    }
  };

  const subjectLine = `Please review and sign: ${contract.title}`;

  return (
    <Portal><div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-hud-bg-elev flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <PenTool className="w-5 h-5 text-hud-gold-soft" />
              {step === 'preview' ? 'Preview Email' : 'Send Contract for Signature'}
            </h2>
            <p className="text-sm text-hud-cream-dim mt-1">
              {step === 'preview'
                ? 'Review the email before sending'
                : 'Request an electronic signature on this contract'}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isSending}
            className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {error && (
            <div className="mb-5 p-4 bg-hud-plum/10 border border-hud-plum/30 rounded-lg flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0 mt-0.5" />
              <p className="text-sm text-hud-plum/40">{error}</p>
            </div>
          )}

          {emailReady === false && step === 'form' && (
            <div className="mb-5 p-4 bg-hud-rust/10 border border-hud-rust/30 rounded-lg flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-hud-rust flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-hud-rust/40 mb-1">Email services not configured</p>
                <ul className="text-sm text-hud-rust/80 space-y-0.5">
                  {emailBlockingReasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
                <p className="text-xs text-hud-rust/60 mt-2">
                  Go to Settings &gt; Email Services to verify your domain and sender configuration.
                </p>
              </div>
            </div>
          )}

          {step === 'freezing' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
              <p className="text-hud-cream-soft">Freezing contract content...</p>
              <p className="text-sm text-hud-cream-mute">Creating an immutable snapshot for signing</p>
            </div>
          )}

          {step === 'sending' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
              <p className="text-hud-cream-soft">Sending signature request...</p>
            </div>
          )}

          {step === 'form' && (
            <div className="space-y-5">
              <div className="p-4 bg-hud-bg-card/60 border border-hud-bg-elev rounded-lg">
                <p className="text-sm font-medium text-hud-cream-soft mb-1">{contract.title}</p>
                {contract.total_value > 0 && (
                  <p className="text-lg font-semibold text-hud-gold-soft">
                    {formatCurrency(contract.total_value, contract.currency)}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  <User className="w-4 h-4 inline mr-1" />
                  Signer Name <span className="text-hud-plum">*</span>
                </label>
                <input
                  type="text"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder="Full name"
                  className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  <Mail className="w-4 h-4 inline mr-1" />
                  Signer Email <span className="text-hud-plum">*</span>
                </label>
                <input
                  type="email"
                  value={signerEmail}
                  onChange={(e) => setSignerEmail(e.target.value)}
                  placeholder="signer@example.com"
                  className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  <Calendar className="w-4 h-4 inline mr-1" />
                  Expires in (days)
                </label>
                <select
                  value={expirationDays}
                  onChange={(e) => setExpirationDays(Number(e.target.value))}
                  className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>

              <div className="p-4 bg-hud-gold/10 border border-hud-gold/30 rounded-lg">
                <h4 className="text-sm font-medium text-hud-gold-soft mb-2">What happens next</h4>
                <ul className="text-sm text-hud-cream-soft space-y-1">
                  <li>1. The contract content will be frozen (no further edits)</li>
                  <li>2. A secure signing link will be emailed to the signer</li>
                  <li>3. You'll be notified when they view, sign, or decline</li>
                </ul>
              </div>
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 p-4 bg-hud-bg-card/60 border border-hud-bg-elev rounded-lg text-sm">
                <div>
                  <p className="text-hud-cream-mute text-xs uppercase tracking-wider mb-1">From</p>
                  <p className="text-hud-cream-soft">{senderEmail || 'Default sender'}</p>
                </div>
                <div>
                  <p className="text-hud-cream-mute text-xs uppercase tracking-wider mb-1">To</p>
                  <p className="text-hud-cream-soft">{signerName.trim()} &lt;{signerEmail.trim()}&gt;</p>
                </div>
                <div className="col-span-2">
                  <p className="text-hud-cream-mute text-xs uppercase tracking-wider mb-1">Subject</p>
                  <p className="text-hud-cream-soft">{subjectLine}</p>
                </div>
              </div>

              <div className="border border-hud-bg-elev rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-hud-bg-card border-b border-hud-bg-elev flex items-center gap-2">
                  <Eye className="w-4 h-4 text-hud-cream-dim" />
                  <span className="text-xs text-hud-cream-dim uppercase tracking-wider">Email Preview</span>
                </div>
                <div
                  className="bg-white p-0 max-h-80 overflow-auto"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewHtml) }}
                />
              </div>

              <p className="text-xs text-hud-cream-mute text-center">
                The signing link in the preview is a placeholder. A unique secure link will be generated on send.
              </p>
            </div>
          )}
        </div>

        {step === 'form' && (
          <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end gap-3">
            <button
              onClick={onClose}
              disabled={isSending}
              className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePreview}
              disabled={!canProceed || emailReady === false || emailReady === null}
              title={emailReady === false ? 'Email services must be configured before sending signature requests' : undefined}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg transition-colors"
            >
              <Eye className="w-4 h-4" />
              Preview Email
            </button>
          </div>
        )}

        {step === 'preview' && (
          <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-between">
            <button
              onClick={() => setStep('form')}
              className="flex items-center gap-2 px-4 py-2 text-hud-cream-soft hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              onClick={handleSend}
              disabled={isSending}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg transition-colors"
            >
              <Send className="w-4 h-4" />
              Send for Signature
            </button>
          </div>
        )}
      </div>
    </div></Portal>
  );
}
