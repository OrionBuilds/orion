import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  MessageSquare,
  FileText,
  DollarSign,
  Calendar,
  Send,
  XCircle,
  PenTool,
} from 'lucide-react';
import type { ProjectChangeRequest, ProjectChangeOrder } from '../../types';
import { verifyClientPortalToken } from '../../services/projectChangeRequests';
import { getChangeOrderForSigning, signChangeOrder, declineChangeOrder, uploadChangeOrderSignatureImage } from '../../services/projectChangeOrders';
import { getComments, addComment } from '../../services/projectChangeRequestComments';
import { SignatureCapture } from '../../components/proposals/SignatureCapture';
import type { ProjectChangeRequestComment } from '../../types';
import { ChangeRequestStatusBadge } from '../../components/projects/ChangeRequestStatusBadge';
import { formatCurrency } from '../../utils/formatters';

type PageState = 'loading' | 'invalid' | 'ready' | 'signing' | 'signed' | 'declined' | 'error';

interface SignatureData {
  type: 'typed' | 'drawn';
  text?: string;
  imageDataUrl: string;
}

export function PublicChangeRequestStatusPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const [searchParams] = useSearchParams();
  const rawToken = searchParams.get('token');

  const [pageState, setPageState] = useState<PageState>('loading');
  const [changeRequest, setChangeRequest] = useState<ProjectChangeRequest | null>(null);
  const [changeOrder, setChangeOrder] = useState<ProjectChangeOrder | null>(null);
  const [comments, setComments] = useState<ProjectChangeRequestComment[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [signatureData, setSignatureData] = useState<SignatureData | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [showDeclineForm, setShowDeclineForm] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    async function load() {
      if (!requestId || !rawToken) {
        setPageState('invalid');
        return;
      }
      const request = await verifyClientPortalToken(requestId, rawToken);
      if (!request) {
        setPageState('invalid');
        return;
      }
      setChangeRequest(request);

      const orders = request.change_orders ?? [];
      const active = orders.find((o) => ['sent', 'viewed'].includes(o.status));
      if (active) {
        setChangeOrder(active);
      }

      const msgs = await getComments(requestId, false, rawToken ?? undefined);
      setComments(msgs);
      setPageState('ready');
    }
    load();
  }, [requestId, rawToken]);

  async function handleSendMessage() {
    if (!newMessage.trim() || !changeRequest) return;
    setSendingMessage(true);
    try {
      const c = await addComment({
        changeRequestId: changeRequest.id,
        orgId: changeRequest.org_id,
        body: newMessage,
        isInternal: false,
        authorType: 'client',
        authorName: changeRequest.client_name,
        // Token-verified RPC path — the anon direct INSERT this page used was
        // token-blind and has been dropped (20260824222000).
        portalToken: rawToken ?? undefined,
      });
      setComments((prev) => [...prev, c]);
      setNewMessage('');
    } catch (err) {
      console.error(err);
    } finally {
      setSendingMessage(false);
    }
  }

  async function handleSign() {
    if (!signatureData || !consentChecked || !changeOrder || !changeRequest || !rawToken) return;
    setProcessing(true);
    setErrorMsg('');
    try {
      let signatureImageUrl: string | undefined;
      if (signatureData.imageDataUrl) {
        signatureImageUrl = await uploadChangeOrderSignatureImage(
          changeRequest.org_id,
          changeOrder.id,
          signatureData.imageDataUrl
        ) ?? undefined;
      }

      const ipRes = await fetch('https://api.ipify.org?format=json').catch(() => null);
      const ipData = ipRes ? await ipRes.json().catch(() => null) : null;

      await signChangeOrder({
        changeOrderId: changeOrder.id,
        changeRequest,
        rawToken: searchParams.get('orderToken') ?? rawToken,
        signatureType: signatureData.type,
        signatureText: signatureData.text,
        signatureImageUrl,
        signerName: changeRequest.client_name,
        signerEmail: changeRequest.client_email ?? '',
        consentText: 'I agree to the terms outlined in this change order and authorize the described changes.',
        ipAddress: ipData?.ip,
        userAgent: navigator.userAgent,
      });

      setChangeRequest((r) => r ? { ...r, status: 'approved', client_decision: 'approved' } : r);
      setChangeOrder((o) => o ? { ...o, status: 'signed' } : o);
      setPageState('signed');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Signing failed. Please try again.');
    } finally {
      setProcessing(false);
    }
  }

  async function handleDecline() {
    if (!changeOrder || !changeRequest || !rawToken) return;
    setProcessing(true);
    setErrorMsg('');
    try {
      await declineChangeOrder({
        changeOrderId: changeOrder.id,
        changeRequest,
        rawToken: searchParams.get('orderToken') ?? rawToken,
        reason: declineReason || undefined,
        ipAddress: undefined,
      });
      setChangeRequest((r) => r ? { ...r, client_decision: 'declined' } : r);
      setChangeOrder((o) => o ? { ...o, status: 'declined' } : o);
      setPageState('declined');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to decline. Please try again.');
    } finally {
      setProcessing(false);
      setShowDeclineForm(false);
    }
  }

  if (pageState === 'loading') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  if (pageState === 'invalid') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 bg-hud-plum/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-7 h-7 text-hud-plum" />
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Invalid or Expired Link</h1>
          <p className="text-hud-cream-dim text-sm">This status link is invalid or has expired. Please contact the project team for a new link.</p>
        </div>
      </div>
    );
  }

  if (pageState === 'signed') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="bg-hud-bg-mid border border-hud-bg-card rounded-2xl p-8 shadow-2xl">
            <div className="w-16 h-16 bg-hud-emerald/20 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <CheckCircle2 className="w-8 h-8 text-hud-emerald" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Change Order Signed</h1>
            <p className="text-hud-cream-dim text-sm">
              Thank you! Your approval has been recorded. The project team has been notified and work will proceed according to the agreed terms.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (pageState === 'declined') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="bg-hud-bg-mid border border-hud-bg-card rounded-2xl p-8 shadow-2xl">
            <div className="w-16 h-16 bg-hud-cream-mute/20 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <XCircle className="w-8 h-8 text-hud-cream-dim" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Change Order Declined</h1>
            <p className="text-hud-cream-dim text-sm">
              You have declined this change order. The project team has been notified and will be in touch to discuss alternatives.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!changeRequest) return null;

  const hasSignableOrder = changeOrder && ['sent', 'viewed'].includes(changeOrder.status);

  return (
    <div className="min-h-dvh bg-hud-bg-deep py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="text-center mb-6">
          <div className="w-10 h-10 bg-hud-gold/20 rounded-xl flex items-center justify-center mx-auto mb-3">
            <FileText className="w-5 h-5 text-hud-gold-soft" />
          </div>
          <h1 className="text-xl font-bold text-white">Change Request Status</h1>
        </div>

        <div className="bg-hud-bg-mid border border-hud-bg-card rounded-2xl p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-base font-semibold text-white">{changeRequest.title}</h2>
              <p className="text-xs text-hud-cream-dim mt-0.5">
                Submitted {new Date(changeRequest.created_at).toLocaleDateString()}
              </p>
            </div>
            <ChangeRequestStatusBadge status={changeRequest.status} />
          </div>

          <StatusTimeline status={changeRequest.status} />

          <div className="mt-5 pt-5 border-t border-hud-bg-card">
            <p className="text-sm text-hud-cream-soft leading-relaxed whitespace-pre-wrap">{changeRequest.description}</p>
          </div>

          {(changeRequest.timeline_impact_days > 0 || changeRequest.cost_impact > 0) && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              {changeRequest.timeline_impact_days > 0 && (
                <div className="bg-hud-bg-card rounded-xl p-3 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-hud-cream-dim" />
                  <div>
                    <p className="text-xs text-hud-cream-dim">Timeline Impact</p>
                    <p className="text-sm font-semibold text-white">+{changeRequest.timeline_impact_days} days</p>
                  </div>
                </div>
              )}
              {changeRequest.cost_impact > 0 && (
                <div className="bg-hud-bg-card rounded-xl p-3 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-hud-cream-dim" />
                  <div>
                    <p className="text-xs text-hud-cream-dim">Cost Impact</p>
                    <p className="text-sm font-semibold text-white">+${Number(changeRequest.cost_impact).toLocaleString()}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {hasSignableOrder && changeOrder && (
          <div className="bg-hud-bg-mid border border-hud-rust/30 rounded-2xl p-6 shadow-xl">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-hud-rust animate-pulse" />
              <h3 className="text-sm font-semibold text-white">Change Order Awaiting Your Approval</h3>
            </div>

            {changeOrder.frozen_html_snapshot ? (
              <div className="bg-white rounded-xl overflow-hidden border border-hud-bg-elev mb-5">
                <iframe
                  srcDoc={changeOrder.frozen_html_snapshot}
                  className="w-full h-96"
                  title="Change Order Document"
                  sandbox="allow-same-origin"
                />
              </div>
            ) : (
              <div className="bg-hud-bg-card border border-hud-bg-elev rounded-xl p-4 mb-5 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-hud-cream-dim">Additional Cost</span>
                  <span className="text-white font-semibold">
                    {formatCurrency(changeOrder.cost_amount, changeOrder.currency)}
                  </span>
                </div>
                {changeOrder.timeline_extension_days > 0 && (
                  <div className="flex justify-between">
                    <span className="text-hud-cream-dim">Timeline Extension</span>
                    <span className="text-white font-semibold">+{changeOrder.timeline_extension_days} days</span>
                  </div>
                )}
              </div>
            )}

            {!showDeclineForm && pageState === 'ready' && (
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold text-hud-cream-soft mb-2">Your Signature</p>
                  <SignatureCapture
                    signerName={changeRequest.client_name}
                    onSignatureChange={setSignatureData}
                  />
                </div>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentChecked}
                    onChange={(e) => setConsentChecked(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-dim leading-relaxed">
                    I agree to the terms outlined in this change order and authorize the described changes, including any additional costs and timeline extensions.
                  </span>
                </label>

                {errorMsg && (
                  <div className="flex items-center gap-2 text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/20 rounded-lg px-3 py-2">
                    <AlertCircle className="w-4 h-4 flex-none" />
                    {errorMsg}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={handleSign}
                    disabled={processing || !signatureData || !consentChecked}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-hud-emerald-dim hover:bg-hud-emerald disabled:opacity-50 text-white hover:text-hud-bg-deep font-semibold text-sm rounded-xl transition-colors"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {processing ? 'Processing...' : 'Approve & Sign'}
                  </button>
                  <button
                    onClick={() => setShowDeclineForm(true)}
                    className="px-4 py-2.5 bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft hover:text-white text-sm rounded-xl transition-colors"
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}

            {showDeclineForm && (
              <div className="space-y-3">
                <p className="text-sm text-hud-cream-soft">Please let us know why you are declining this change order:</p>
                <textarea
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  rows={3}
                  placeholder="Reason (optional)"
                  className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-plum resize-none"
                />
                {errorMsg && (
                  <div className="flex items-center gap-2 text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/20 rounded-lg px-3 py-2">
                    <AlertCircle className="w-4 h-4 flex-none" />
                    {errorMsg}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => setShowDeclineForm(false)} className="flex-1 py-2.5 text-sm text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-xl transition-colors">
                    Back
                  </button>
                  <button
                    onClick={handleDecline}
                    disabled={processing}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-hud-plum hover:bg-hud-plum disabled:opacity-50 text-white text-sm rounded-xl transition-colors"
                  >
                    <XCircle className="w-4 h-4" />
                    {processing ? 'Processing...' : 'Confirm Decline'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="bg-hud-bg-mid border border-hud-bg-card rounded-2xl p-6 shadow-xl">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="w-4 h-4 text-hud-cream-dim" />
            <h3 className="text-sm font-semibold text-white">Messages</h3>
          </div>

          {comments.length === 0 ? (
            <p className="text-sm text-hud-cream-mute text-center py-4">No messages yet.</p>
          ) : (
            <div className="space-y-3 mb-4">
              {comments.map((c) => (
                <div key={c.id} className={`flex gap-3 ${c.author_type === 'client' ? 'flex-row-reverse' : ''}`}>
                  <div className="w-7 h-7 rounded-full bg-hud-bg-elev flex items-center justify-center text-xs font-semibold text-hud-cream-soft flex-none">
                    {(c.author_name ?? 'T').charAt(0).toUpperCase()}
                  </div>
                  <div className={`flex-1 rounded-xl px-3 py-2.5 ${c.author_type === 'client' ? 'bg-hud-gold-deep/20 border border-hud-gold/30' : 'bg-hud-bg-card border border-hud-bg-elev'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-white">{c.author_name ?? 'Team'}</span>
                      <span className="text-xs text-hud-cream-mute">{new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                    <p className="text-sm text-hud-cream-soft whitespace-pre-wrap">{c.body}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <textarea
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              rows={2}
              placeholder="Send a message to the project team..."
              className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-mute focus:outline-none focus:border-hud-gold resize-none"
            />
            <button
              onClick={handleSendMessage}
              disabled={sendingMessage || !newMessage.trim()}
              className="px-3 py-2 bg-hud-gold-deep hover:bg-hud-gold-deep disabled:opacity-50 text-white rounded-lg self-end transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusTimeline({ status }: { status: string }) {
  const steps = [
    { key: 'submitted', label: 'Submitted' },
    { key: 'under_review', label: 'Under Review' },
    { key: 'quoted_awaiting_approval', label: 'Awaiting Approval' },
    { key: 'approved', label: 'Approved' },
    { key: 'completed', label: 'Completed' },
  ];

  const terminalStatuses = ['rejected', 'cancelled'];
  const stepKeys = steps.map((s) => s.key);
  const currentIndex = stepKeys.indexOf(status);

  if (terminalStatuses.includes(status)) {
    return (
      <div className="flex items-center gap-2 py-2">
        <XCircle className="w-4 h-4 text-hud-plum" />
        <span className="text-xs text-hud-plum capitalize font-medium">{status}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 mt-4">
      {steps.map((step, i) => {
        const done = currentIndex > i;
        const active = currentIndex === i;
        return (
          <div key={step.key} className="flex items-center gap-1 flex-1">
            <div className="flex flex-col items-center gap-1 flex-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                done ? 'bg-hud-emerald text-hud-bg-deep' : active ? 'bg-hud-gold text-hud-bg-deep' : 'bg-hud-bg-elev text-hud-cream-mute'
              }`}>
                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className={`text-xs text-center leading-tight ${active ? 'text-hud-gold-soft font-medium' : done ? 'text-hud-emerald' : 'text-hud-cream-mute'}`}>
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`h-px flex-1 mt-0 mb-4 ${done ? 'bg-hud-emerald' : 'bg-hud-bg-elev'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
