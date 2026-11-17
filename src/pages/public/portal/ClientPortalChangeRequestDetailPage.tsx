import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Clock,
  DollarSign,
  Calendar,
  Send,
  User,
  FileText,
  CheckCircle2,
  XCircle,
  MessageSquare,
  AlertTriangle,
  PenTool,
  Download,
  ExternalLink,
} from 'lucide-react';
import { useClientPortal } from '../../../contexts/ClientPortalContext';
import {
  getPortalChangeRequestById,
  getPortalComments,
  clientApproveChangeRequest,
  clientRejectChangeRequest,
  clientAddComment,
} from '../../../services/projectClientPortals';
import { PortalStatusBadge } from '../../../components/portal/PortalStatusBadge';
import { ApproveChangeModal } from '../../../components/portal/ApproveChangeModal';
import { RejectChangeModal } from '../../../components/portal/RejectChangeModal';
import { ClarificationModal } from '../../../components/portal/ClarificationModal';
import { PortalStepUpModal } from '../../../components/portal/PortalStepUpModal';
import { SignatureCapture } from '../../../components/proposals/SignatureCapture';
import { signChangeOrder, declineChangeOrder, uploadChangeOrderSignatureImage } from '../../../services/projectChangeOrders';
import type { ProjectChangeRequest, ProjectChangeRequestComment, ProjectChangeOrder } from '../../../types';
import { formatCurrency } from '../../../utils/formatters';

const TYPE_LABELS: Record<string, string> = {
  scope: 'Scope Change',
  timeline: 'Timeline Adjustment',
  design: 'Design Change',
  feature: 'New Feature',
  bugfix: 'Bug Fix',
  support: 'Support Request',
  other: 'Other',
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: 'Low', color: 'text-hud-cream-mute' },
  medium: { label: 'Medium', color: 'text-hud-rust' },
  high: { label: 'High', color: 'text-hud-rust' },
  critical: { label: 'Critical', color: 'text-hud-plum' },
};

interface SignatureData {
  type: 'typed' | 'drawn';
  text?: string;
  imageDataUrl: string;
}

type ActionState = 'idle' | 'approving' | 'rejecting' | 'clarifying';
type SigningState = 'idle' | 'signing' | 'signed' | 'declined';
type StepUpPending = 'approve' | 'reject' | 'sign' | 'decline' | null;

export function ClientPortalChangeRequestDetailPage() {
  const { projectId, requestId } = useParams<{ projectId: string; requestId: string }>();
  const { portal, needsStepUp, completeStepUp } = useClientPortal();
  const navigate = useNavigate();

  const [request, setRequest] = useState<ProjectChangeRequest | null>(null);
  const [comments, setComments] = useState<ProjectChangeRequestComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [signingState, setSigningState] = useState<SigningState>('idle');
  const [newMessage, setNewMessage] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [signatureData, setSignatureData] = useState<SignatureData | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [signingError, setSigningError] = useState('');
  const [processingSign, setProcessingSign] = useState(false);
  const [stepUpPending, setStepUpPending] = useState<StepUpPending>(null);
  const [pendingRejectReason, setPendingRejectReason] = useState<string | null>(null);

  useEffect(() => {
    if (!requestId || !portal) return;
    Promise.all([
      getPortalChangeRequestById(requestId),
      getPortalComments(requestId),
    ]).then(([req, msgs]) => {
      setRequest(req);
      setComments(msgs);
    }).catch(console.error).finally(() => setLoading(false));
  }, [requestId, portal]);

  if (!portal) return null;

  const contact = portal.contact;
  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Client'
    : 'Client';

  const base = `/client-portal/projects/${projectId}`;

  function requestWithStepUp(action: StepUpPending, onProceed: () => void) {
    if (needsStepUp()) {
      setStepUpPending(action);
    } else {
      onProceed();
    }
  }

  function handleStepUpSuccess() {
    const pending = stepUpPending;
    setStepUpPending(null);
    completeStepUp();
    if (pending === 'approve') {
      setActionState('approving');
    } else if (pending === 'reject') {
      setActionState('rejecting');
    } else if (pending === 'sign') {
      void handleSignChangeOrder();
    } else if (pending === 'decline') {
      void handleDeclineChangeOrder();
    }
  }

  const STEP_UP_LABELS: Record<NonNullable<StepUpPending>, string> = {
    approve: 'approving this change request',
    reject: 'rejecting this change request',
    sign: 'signing this change order',
    decline: 'declining this change order',
  };

  /** The server enforces step-up on approve/reject now (30-min OTP window).
   *  If it refuses despite the local needsStepUp() gate — stale local
   *  timestamp, session verified in another tab — reopen the step-up modal
   *  instead of surfacing a raw "step_up_required" error string. */
  function isStepUpRefusal(err: unknown): boolean {
    return err instanceof Error && err.message.includes('step_up_required');
  }

  async function handleApprove() {
    if (!request || !portal) return;
    try {
      await clientApproveChangeRequest({
        requestId: request.id,
        portalId: portal.id,
        projectId: portal.project_id,
        contactId: portal.contact_id,
      });
    } catch (err) {
      if (isStepUpRefusal(err)) {
        setActionState('idle');
        setStepUpPending('approve');
        return;
      }
      throw err;
    }
    setRequest((r) => r ? { ...r, status: 'approved', client_decision: 'approved' } : r);
    setActionState('idle');
  }

  async function handleReject(reason: string) {
    if (!request || !portal) return;
    try {
      await clientRejectChangeRequest({
        requestId: request.id,
        portalId: portal.id,
        projectId: portal.project_id,
        contactId: portal.contact_id,
        reason,
      });
    } catch (err) {
      if (isStepUpRefusal(err)) {
        setActionState('idle');
        setPendingRejectReason(reason);
        setStepUpPending('reject');
        return;
      }
      throw err;
    }
    setRequest((r) => r ? { ...r, status: 'rejected', client_decision: 'declined' } : r);
    setActionState('idle');
    setPendingRejectReason(null);
  }

  async function handleClarification(message: string) {
    if (!request || !portal) return;
    await clientAddComment({
      changeRequestId: request.id,
      orgId: portal.org_id,
      body: message,
      authorName: contactName,
      portalId: portal.id,
      projectId: portal.project_id,
      contactId: portal.contact_id,
    });
    const updated = await getPortalComments(request.id);
    setComments(updated);
    setActionState('idle');
  }

  async function handleSendMessage() {
    if (!newMessage.trim() || !request || !portal) return;
    setSendingMessage(true);
    try {
      await clientAddComment({
        changeRequestId: request.id,
        orgId: portal.org_id,
        body: newMessage,
        authorName: contactName,
        portalId: portal.id,
        projectId: portal.project_id,
        contactId: portal.contact_id,
      });
      const updated = await getPortalComments(request.id);
      setComments(updated);
      setNewMessage('');
    } catch (err) {
      console.error(err);
    } finally {
      setSendingMessage(false);
    }
  }

  const activeChangeOrder = request?.change_orders?.find(
    (o): o is ProjectChangeOrder => ['sent', 'viewed'].includes(o.status)
  ) ?? null;

  async function handleSignChangeOrder() {
    if (!signatureData || !consentChecked || !activeChangeOrder || !request) return;
    setProcessingSign(true);
    setSigningError('');
    try {
      let signatureImageUrl: string | undefined;
      if (signatureData.imageDataUrl) {
        signatureImageUrl = await uploadChangeOrderSignatureImage(
          request.org_id,
          activeChangeOrder.id,
          signatureData.imageDataUrl
        ) ?? undefined;
      }
      await signChangeOrder({
        changeOrderId: activeChangeOrder.id,
        changeRequest: request,
        rawToken: activeChangeOrder.access_token_hash ?? '',
        signatureType: signatureData.type,
        signatureText: signatureData.text,
        signatureImageUrl,
        signerName: contactName,
        signerEmail: contact?.email ?? '',
        consentText: 'I agree to the terms outlined in this change order and authorize the described changes.',
        userAgent: navigator.userAgent,
      });
      setRequest((r) => r ? { ...r, status: 'approved', client_decision: 'approved' } : r);
      setSigningState('signed');
    } catch (err) {
      setSigningError(err instanceof Error ? err.message : 'Signing failed. Please try again.');
    } finally {
      setProcessingSign(false);
    }
  }

  async function handleDeclineChangeOrder() {
    if (!activeChangeOrder || !request) return;
    setProcessingSign(true);
    setSigningError('');
    try {
      await declineChangeOrder({
        changeOrderId: activeChangeOrder.id,
        changeRequest: request,
        rawToken: activeChangeOrder.access_token_hash ?? '',
        // `userAgent` removed: declineChangeOrder's params don't include it and the
        // service never read it, so the value was silently ignored at runtime.
      });
      setRequest((r) => r ? { ...r, client_decision: 'declined' } : r);
      setSigningState('declined');
    } catch (err) {
      setSigningError(err instanceof Error ? err.message : 'Failed to decline. Please try again.');
    } finally {
      setProcessingSign(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold" />
      </div>
    );
  }

  if (!request) {
    return (
      <div className="text-center py-16">
        <p className="text-hud-cream-mute">Change request not found.</p>
      </div>
    );
  }

  const isAwaitingApproval = request.status === 'quoted_awaiting_approval';
  const priorityConfig = PRIORITY_CONFIG[request.priority] ?? PRIORITY_CONFIG.medium;

  return (
    <div className="space-y-5 max-w-3xl">
      <button
        onClick={() => navigate(`${base}/change-requests`)}
        className="flex items-center gap-1.5 text-sm text-hud-cream-mute hover:text-white transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Change Requests
      </button>

      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-hud-cream-soft mb-1">{request.title}</h1>
            <div className="flex items-center gap-3 flex-wrap text-xs text-hud-cream-mute">
              <span className="capitalize">{TYPE_LABELS[request.request_type] ?? request.request_type}</span>
              <span>&middot;</span>
              <span className={priorityConfig.color}>{priorityConfig.label} priority</span>
              <span>&middot;</span>
              <span>Submitted {new Date(request.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </div>
          </div>
          <PortalStatusBadge status={request.status} size="lg" />
        </div>

        <StatusProgressBar status={request.status} />
      </div>

      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-6">
        <h2 className="text-sm font-semibold text-white mb-3">Request Details</h2>
        <p className="text-sm text-white leading-relaxed whitespace-pre-wrap">{request.description}</p>

        <div className="grid grid-cols-2 gap-4 mt-4">
          {request.requested_due_date && (
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="w-4 h-4 text-hud-cream-dim" />
              <div>
                <div className="text-xs text-hud-cream-dim">Requested by</div>
                <div className="text-white font-medium">
                  {new Date(request.requested_due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <User className="w-4 h-4 text-hud-cream-dim" />
            <div>
              <div className="text-xs text-hud-cream-dim">Submitted by</div>
              <div className="text-white font-medium">{request.client_name}</div>
            </div>
          </div>
        </div>
      </div>

      {(request.client_summary || (request.cost_impact_visible_to_client && request.cost_impact > 0) || (request.timeline_impact_visible_to_client && request.timeline_impact_days > 0)) && (
        <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-6">
          <h2 className="text-sm font-semibold text-white mb-3">Team Assessment</h2>

          {request.client_summary && (
            <p className="text-sm text-white leading-relaxed mb-4">{request.client_summary}</p>
          )}

          <div className="grid grid-cols-2 gap-4">
            {request.cost_impact_visible_to_client && request.cost_impact > 0 && (
              <div className="flex items-center gap-3 bg-hud-rust/10 border border-hud-rust/15 rounded-xl p-4">
                <div className="w-8 h-8 bg-hud-rust/15 rounded-lg flex items-center justify-center">
                  <DollarSign className="w-4 h-4 text-hud-rust" />
                </div>
                <div>
                  <div className="text-xs text-hud-cream-mute">Cost Impact</div>
                  <div className="text-base font-bold text-hud-cream-soft">+${Number(request.cost_impact).toLocaleString()}</div>
                </div>
              </div>
            )}
            {request.timeline_impact_visible_to_client && request.timeline_impact_days > 0 && (
              <div className="flex items-center gap-3 bg-hud-gold/10 border border-hud-gold/20 rounded-xl p-4">
                <div className="w-8 h-8 bg-hud-gold/20 rounded-lg flex items-center justify-center">
                  <Clock className="w-4 h-4 text-hud-gold" />
                </div>
                <div>
                  <div className="text-xs text-hud-cream-mute">Timeline Impact</div>
                  <div className="text-base font-bold text-hud-cream-soft">+{request.timeline_impact_days} days</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {activeChangeOrder && signingState === 'idle' && (
        <div className="bg-hud-bg-elev rounded-2xl border border-hud-rust/40 p-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-hud-rust animate-pulse" />
            <h2 className="text-sm font-semibold text-hud-cream-soft">Change Order Awaiting Your Signature</h2>
          </div>

          {activeChangeOrder.frozen_html_snapshot ? (
            <div className="bg-hud-bg-elev rounded-xl overflow-hidden border border-hud-line mb-5">
              <iframe
                srcDoc={activeChangeOrder.frozen_html_snapshot}
                className="w-full h-80"
                title="Change Order Document"
                sandbox="allow-same-origin"
              />
            </div>
          ) : (
            <div className="bg-hud-bg-elev border border-hud-line rounded-xl p-4 mb-5 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-hud-cream-mute">Additional Cost</span>
                <span className="font-semibold text-hud-cream-soft">
                  {formatCurrency(activeChangeOrder.cost_amount, activeChangeOrder.currency)}
                </span>
              </div>
              {activeChangeOrder.timeline_extension_days > 0 && (
                <div className="flex justify-between">
                  <span className="text-hud-cream-mute">Timeline Extension</span>
                  <span className="font-semibold text-hud-cream-soft">+{activeChangeOrder.timeline_extension_days} days</span>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold text-white mb-2">Your Signature</p>
              <SignatureCapture signerName={contactName} onSignatureChange={setSignatureData} />
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-blue-600"
              />
              <span className="text-xs text-hud-cream-mute leading-relaxed">
                I agree to the terms outlined in this change order and authorize the described changes, including any additional costs and timeline extensions.
              </span>
            </label>

            {signingError && (
              <div className="flex items-center gap-2 text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/25 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 flex-none" />
                {signingError}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => requestWithStepUp('sign', () => void handleSignChangeOrder())}
                disabled={processingSign || !signatureData || !consentChecked}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-hud-emerald-dim hover:bg-hud-emerald disabled:opacity-50 text-white hover:text-hud-bg-deep font-semibold text-sm rounded-xl transition-colors"
              >
                <PenTool className="w-4 h-4" />
                {processingSign ? 'Processing...' : 'Approve & Sign'}
              </button>
              <button
                onClick={() => requestWithStepUp('decline', () => void handleDeclineChangeOrder())}
                disabled={processingSign}
                className="px-4 py-2.5 bg-hud-bg-mid hover:bg-hud-bg-mute text-white text-sm font-medium rounded-xl transition-colors"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {signingState === 'signed' && (
        <div className="bg-hud-emerald/10 border border-hud-emerald/25 rounded-2xl p-6 text-center">
          <CheckCircle2 className="w-10 h-10 text-hud-emerald-dim mx-auto mb-3" />
          <h3 className="text-base font-bold text-hud-cream-soft mb-1">Change Order Signed</h3>
          <p className="text-sm text-hud-cream-mute">Thank you. The project team has been notified and will proceed with the changes.</p>
        </div>
      )}

      {signingState === 'declined' && (
        <div className="bg-hud-bg-elev border border-hud-line rounded-2xl p-6 text-center">
          <XCircle className="w-8 h-8 text-hud-cream-mute mx-auto mb-3" />
          <h3 className="text-base font-bold text-hud-cream-soft mb-1">Change Order Declined</h3>
          <p className="text-sm text-hud-cream-mute">You have declined this change order. The project team will be in touch to discuss alternatives.</p>
        </div>
      )}

      {isAwaitingApproval && signingState === 'idle' && !activeChangeOrder && (
        <div className="bg-hud-rust/10 border border-hud-rust/30 rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-hud-rust animate-pulse" />
            <h2 className="text-sm font-semibold text-hud-cream-soft">Action Required</h2>
          </div>
          <p className="text-sm text-hud-cream-mute mb-4">
            This change request has been reviewed and is ready for your approval. Please review the details above and make your decision.
          </p>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => requestWithStepUp('approve', () => setActionState('approving'))}
              className="flex items-center gap-2 px-4 py-2.5 bg-hud-emerald-dim hover:bg-hud-emerald text-white hover:text-hud-bg-deep text-sm font-semibold rounded-xl transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" />
              Approve Change
            </button>
            <button
              onClick={() => requestWithStepUp('reject', () => setActionState('rejecting'))}
              className="flex items-center gap-2 px-4 py-2.5 bg-hud-plum hover:bg-hud-plum text-white text-sm font-semibold rounded-xl transition-colors"
            >
              <XCircle className="w-4 h-4" />
              Reject Change
            </button>
            <button
              onClick={() => setActionState('clarifying')}
              className="flex items-center gap-2 px-4 py-2.5 bg-hud-bg-mid hover:bg-hud-bg-mute text-white text-sm font-medium rounded-xl transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
              Request Clarification
            </button>
          </div>
        </div>
      )}

      {(request.attachments?.length > 0 || request.change_orders?.some(o => o.status === 'signed')) && (
        <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-6">
          <h2 className="text-sm font-semibold text-white mb-3">Documents</h2>
          <div className="space-y-2">
            {request.change_orders?.filter(o => ['signed', 'sent', 'viewed'].includes(o.status)).map((order) => (
              <div key={order.id} className="flex items-center justify-between p-3 bg-hud-bg-elev border border-hud-line rounded-xl">
                <div className="flex items-center gap-3">
                  <FileText className="w-4 h-4 text-hud-cream-dim" />
                  <div>
                    <div className="text-sm font-medium text-hud-cream-soft">{order.title}</div>
                    <div className={`text-xs capitalize ${
                      order.status === 'signed' ? 'text-hud-emerald-dim' :
                      order.status === 'sent' || order.status === 'viewed' ? 'text-hud-rust' :
                      'text-hud-cream-mute'
                    }`}>
                      Change Order &middot; {order.status}
                    </div>
                  </div>
                </div>
                {order.frozen_html_snapshot && (
                  <button className="p-1.5 text-hud-cream-dim hover:text-hud-cream-mute hover:bg-hud-bg-mid rounded-lg transition-colors">
                    <ExternalLink className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}

            {request.attachments?.map((att, i) => (
              <a
                key={i}
                href={att.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 bg-hud-bg-elev border border-hud-line rounded-xl hover:bg-hud-bg-mid transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <FileText className="w-4 h-4 text-hud-cream-dim" />
                  <span className="text-sm font-medium text-hud-cream-soft">{att.name}</span>
                </div>
                <Download className="w-4 h-4 text-hud-cream-dim group-hover:text-hud-cream-mute" />
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-6">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="w-4 h-4 text-hud-cream-dim" />
          <h2 className="text-sm font-semibold text-white">Messages & Updates</h2>
        </div>

        {comments.length === 0 ? (
          <p className="text-sm text-hud-cream-dim text-center py-4">No messages yet.</p>
        ) : (
          <div className="space-y-4 mb-5">
            {comments.map((c) => {
              const isClient = c.author_type === 'client';
              return (
                <div key={c.id} className={`flex gap-3 ${isClient ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-none ${
                    isClient ? 'bg-hud-gold-deep text-white' : 'bg-hud-bg-mute text-white'
                  }`}>
                    {(c.author_name ?? 'T').charAt(0).toUpperCase()}
                  </div>
                  <div className={`flex-1 max-w-[85%] rounded-2xl px-4 py-3 ${
                    isClient ? 'bg-hud-gold-deep text-white rounded-tr-sm' : 'bg-hud-bg-mid text-hud-cream-soft rounded-tl-sm'
                  }`}>
                    <div className={`flex items-center gap-2 mb-1 ${isClient ? 'flex-row-reverse' : ''}`}>
                      <span className={`text-xs font-medium ${isClient ? 'text-white/80' : 'text-hud-cream-mute'}`}>
                        {isClient ? 'You' : (c.author_name ?? 'Project Team')}
                      </span>
                      <span className={`text-xs ${isClient ? 'text-white/60' : 'text-hud-cream-dim'}`}>
                        {new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' '}
                        {new Date(c.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-3">
          <textarea
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            rows={2}
            placeholder="Send a message to the project team..."
            className="flex-1 px-3 py-2.5 text-sm border border-hud-line rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-gold/30 focus:border-hud-gold resize-none text-hud-cream-soft placeholder-hud-cream-dim"
          />
          <button
            onClick={handleSendMessage}
            disabled={sendingMessage || !newMessage.trim()}
            className="px-3 py-2.5 bg-hud-gold-deep hover:bg-hud-gold disabled:opacity-50 text-white hover:text-hud-bg-deep rounded-xl self-end transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      {actionState === 'approving' && (
        <ApproveChangeModal
          request={request}
          onConfirm={handleApprove}
          onClose={() => setActionState('idle')}
        />
      )}

      {actionState === 'rejecting' && (
        <RejectChangeModal
          request={request}
          onConfirm={handleReject}
          onClose={() => { setActionState('idle'); setPendingRejectReason(null); }}
        />
      )}

      {actionState === 'clarifying' && (
        <ClarificationModal
          authorName={contactName}
          onSend={handleClarification}
          onClose={() => setActionState('idle')}
        />
      )}

      {stepUpPending && (
        <PortalStepUpModal
          actionLabel={STEP_UP_LABELS[stepUpPending]}
          onSuccess={handleStepUpSuccess}
          onCancel={() => setStepUpPending(null)}
        />
      )}
    </div>
  );
}

function StatusProgressBar({ status }: { status: string }) {
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
      <div className="flex items-center gap-2 mt-4 py-2">
        <XCircle className="w-4 h-4 text-hud-plum" />
        <span className="text-sm text-hud-plum font-medium capitalize">{status}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 mt-5">
      {steps.map((step, i) => {
        const done = currentIndex > i;
        const active = currentIndex === i;
        return (
          <div key={step.key} className="flex items-center gap-1 flex-1">
            <div className="flex flex-col items-center gap-1 flex-none">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                done ? 'bg-hud-emerald text-hud-bg-deep' :
                active ? 'bg-hud-gold-deep text-white' :
                'bg-hud-bg-mid text-hud-cream-dim'
              }`}>
                {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
              </div>
              <span className={`text-xs text-center leading-tight w-16 ${
                active ? 'text-hud-gold font-semibold' :
                done ? 'text-hud-emerald-dim' :
                'text-hud-cream-dim'
              }`}>
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`h-0.5 flex-1 mb-4 ${done ? 'bg-hud-emerald' : 'bg-hud-bg-mid'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
