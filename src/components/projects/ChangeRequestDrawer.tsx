import { useState, useEffect, useCallback } from 'react';
import {
  X,
  User,
  MessageSquare,
  Clock,
  DollarSign,
  Calendar,
  ChevronDown,
  Send,
  Lock,
  Unlock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileText,
  Copy,
  ExternalLink,
  Plus,
  RotateCcw,
} from 'lucide-react';
import type {
  ProjectChangeRequest,
  ProjectChangeRequestComment,
  ProjectChangeRequestAuditEvent,
  ProjectChangeOrder,
  User as UserType,
} from '../../types';
import {
  updateChangeRequest,
  assignReviewer,
  getAuditEvents,
  generateClientPortalToken,
} from '../../services/projectChangeRequests';
import { getComments, addComment } from '../../services/projectChangeRequestComments';
import { createChangeOrder } from '../../services/projectChangeOrders';
import { ChangeRequestStatusBadge } from './ChangeRequestStatusBadge';
import { SendChangeOrderModal } from './SendChangeOrderModal';
import { Portal } from '../shared/Portal';

const TYPE_LABELS: Record<string, string> = {
  scope: 'Scope',
  timeline: 'Timeline',
  design: 'Design',
  feature: 'Feature',
  bugfix: 'Bug Fix',
  support: 'Support',
  other: 'Other',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-hud-cream-dim',
  medium: 'text-hud-rust',
  high: 'text-orange-400',
  critical: 'text-hud-plum',
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  submitted: ['under_review', 'needs_more_info', 'rejected', 'cancelled'],
  under_review: ['needs_more_info', 'quoted_awaiting_approval', 'rejected', 'cancelled'],
  needs_more_info: ['under_review', 'rejected', 'cancelled'],
  quoted_awaiting_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  rejected: [],
  completed: [],
  cancelled: ['submitted'],
};

const STATUS_ACTION_LABELS: Record<string, string> = {
  under_review: 'Start Review',
  needs_more_info: 'Request More Info',
  quoted_awaiting_approval: 'Send for Approval',
  approved: 'Approve',
  rejected: 'Reject',
  scheduled: 'Mark Scheduled',
  in_progress: 'Start Work',
  completed: 'Mark Complete',
  cancelled: 'Cancel',
  submitted: 'Reopen',
};

interface Props {
  changeRequest: ProjectChangeRequest;
  users: UserType[];
  canManage: boolean;
  canApprove: boolean;
  currentUserId: string;
  currentUserName: string;
  onClose: () => void;
  onUpdate: () => Promise<void>;
}

export function ChangeRequestDrawer({
  changeRequest: initialRequest,
  users,
  canManage,
  canApprove,
  currentUserId,
  currentUserName,
  onClose,
  onUpdate,
}: Props) {
  const [request, setRequest] = useState(initialRequest);
  const [comments, setComments] = useState<ProjectChangeRequestComment[]>([]);
  const [auditEvents, setAuditEvents] = useState<ProjectChangeRequestAuditEvent[]>([]);
  const [activeTab, setActiveTab] = useState<'details' | 'comments' | 'audit'>('details');
  const [commentTab, setCommentTab] = useState<'internal' | 'client'>('internal');
  const [newComment, setNewComment] = useState('');
  const [newCommentClientVisible, setNewCommentClientVisible] = useState(false);
  const [addingComment, setSavingComment] = useState(false);
  const [showAssessment, setShowAssessment] = useState(false);
  const [assessment, setAssessment] = useState({
    scope_impact: request.scope_impact ?? '',
    timeline_impact_days: request.timeline_impact_days ?? 0,
    cost_impact: request.cost_impact ?? 0,
    internal_summary: request.internal_summary ?? '',
    client_summary: request.client_summary ?? '',
    cost_impact_visible_to_client: request.cost_impact_visible_to_client ?? false,
    timeline_impact_visible_to_client: request.timeline_impact_visible_to_client ?? false,
  });
  const [savingAssessment, setSavingAssessment] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [copiedPortalLink, setCopiedPortalLink] = useState(false);
  const [showCreateOrder, setShowCreateOrder] = useState(false);
  const [newOrder, setNewOrder] = useState({
    title: '',
    description: '',
    scope_changes: '',
    timeline_extension_days: 0,
    cost_amount: 0,
    currency: 'USD',
    terms_and_conditions: '',
  });
  const [savingOrder, setSavingOrder] = useState(false);
  const [sendOrderTarget, setSendOrderTarget] = useState<ProjectChangeOrder | null>(null);

  const loadData = useCallback(async () => {
    const [c, a] = await Promise.all([
      getComments(request.id, true),
      getAuditEvents(request.id),
    ]);
    setComments(c);
    setAuditEvents(a);
  }, [request.id]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleTransition(newStatus: string, reason?: string) {
    setTransitioning(true);
    try {
      const updated = await updateChangeRequest(
        request.id,
        { status: newStatus as any },
        currentUserId,
        currentUserName
      );
      if (reason) {
        await addComment({
          changeRequestId: request.id,
          orgId: request.org_id,
          body: reason,
          isInternal: true,
          authorType: 'user',
          authorUserId: currentUserId,
          authorName: currentUserName,
        });
      }
      setRequest(updated);
      await onUpdate();
      await loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setTransitioning(false);
      setShowRejectDialog(false);
      setRejectReason('');
    }
  }

  async function handleSaveAssessment() {
    setSavingAssessment(true);
    try {
      const updated = await updateChangeRequest(
        request.id,
        {
          scope_impact: assessment.scope_impact || undefined,
          timeline_impact_days: assessment.timeline_impact_days,
          cost_impact: assessment.cost_impact,
          internal_summary: assessment.internal_summary || undefined,
          client_summary: assessment.client_summary || undefined,
          cost_impact_visible_to_client: assessment.cost_impact_visible_to_client,
          timeline_impact_visible_to_client: assessment.timeline_impact_visible_to_client,
        },
        currentUserId,
        currentUserName
      );
      setRequest(updated);
      setShowAssessment(false);
      await onUpdate();
    } catch (err) {
      console.error(err);
    } finally {
      setSavingAssessment(false);
    }
  }

  async function handleAssignReviewer(userId: string) {
    try {
      await assignReviewer(request.id, userId, currentUserId);
      const updated = { ...request, reviewer_user_id: userId, reviewer: users.find((u) => u.id === userId) ?? null };
      setRequest(updated);
      await onUpdate();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleAddComment() {
    if (!newComment.trim()) return;
    setSavingComment(true);
    const isInternal = commentTab === 'internal';
    try {
      const comment = await addComment({
        changeRequestId: request.id,
        orgId: request.org_id,
        body: newComment,
        isInternal,
        clientVisible: isInternal ? newCommentClientVisible : true,
        authorType: 'user',
        authorUserId: currentUserId,
        authorName: currentUserName,
      });
      setComments((c) => [...c, comment]);
      setNewComment('');
      setNewCommentClientVisible(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingComment(false);
    }
  }

  async function handleCopyPortalLink() {
    try {
      const { clientPortalUrl } = await generateClientPortalToken(request.id);
      await navigator.clipboard.writeText(clientPortalUrl);
      setCopiedPortalLink(true);
      setTimeout(() => setCopiedPortalLink(false), 2500);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleCreateOrder() {
    if (!newOrder.title.trim()) return;
    setSavingOrder(true);
    try {
      await createChangeOrder({
        org_id: request.org_id,
        project_id: request.project_id,
        change_request_id: request.id,
        ...newOrder,
      }, currentUserId);
      setShowCreateOrder(false);
      setNewOrder({ title: '', description: '', scope_changes: '', timeline_extension_days: 0, cost_amount: 0, currency: 'USD', terms_and_conditions: '' });
      await onUpdate();
      const refreshed = { ...request };
      setRequest(refreshed);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingOrder(false);
    }
  }

  const existingOrders = request.change_orders ?? [];
  const activeOrder = existingOrders.find((o) => !['voided', 'declined'].includes(o.status));
  const allowedTransitions = ALLOWED_TRANSITIONS[request.status] ?? [];
  const filteredComments = comments.filter((c) => commentTab === 'internal' ? true : !c.is_internal);

  return (
    <>
      <Portal><div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />
        <div className="relative w-full max-w-2xl bg-hud-bg-mid border-l border-hud-bg-elev flex flex-col h-full overflow-hidden shadow-2xl">
          <div className="flex-none border-b border-hud-bg-elev px-6 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <ChangeRequestStatusBadge status={request.status} />
                  <span className={`text-xs font-medium capitalize ${PRIORITY_COLORS[request.priority]}`}>
                    {request.priority} priority
                  </span>
                  <span className="text-xs text-hud-cream-mute">{TYPE_LABELS[request.request_type]}</span>
                </div>
                <h2 className="text-base font-semibold text-white mt-1.5 leading-snug">{request.title}</h2>
                <p className="text-xs text-hud-cream-dim mt-0.5">
                  Submitted by {request.client_name} · {new Date(request.created_at).toLocaleDateString()}
                </p>
              </div>
              <button onClick={onClose} className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg flex-none">
                <X className="w-4 h-4" />
              </button>
            </div>

            {canManage && allowedTransitions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {allowedTransitions.map((status) => {
                  const isReject = status === 'rejected';
                  return (
                    <button
                      key={status}
                      onClick={() => isReject ? setShowRejectDialog(true) : handleTransition(status)}
                      disabled={transitioning}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
                        isReject
                          ? 'bg-hud-plum/20 text-hud-plum hover:bg-hud-plum/30 border border-hud-plum/30'
                          : status === 'approved'
                          ? 'bg-hud-emerald-dim text-white hover:text-hud-bg-deep hover:bg-hud-emerald'
                          : status === 'completed'
                          ? 'bg-hud-emerald-dim/80 text-white hover:bg-hud-emerald-dim'
                          : 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute hover:text-white'
                      }`}
                    >
                      {STATUS_ACTION_LABELS[status] ?? status.replace(/_/g, ' ')}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex-none border-b border-hud-bg-elev px-6">
            <nav className="flex gap-1">
              {(['details', 'comments', 'audit'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-2.5 text-xs font-medium capitalize transition-colors border-b-2 ${
                    activeTab === tab
                      ? 'border-hud-gold text-hud-gold-soft'
                      : 'border-transparent text-hud-cream-dim hover:text-white'
                  }`}
                >
                  {tab}
                  {tab === 'comments' && comments.length > 0 && (
                    <span className="ml-1.5 text-xs bg-hud-bg-elev text-hud-cream-soft rounded-full px-1.5">
                      {comments.length}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1 overflow-y-auto">
            {activeTab === 'details' && (
              <div className="p-6 space-y-5">
                <Section title="Client Info">
                  <InfoRow label="Name" value={request.client_name} />
                  {request.client_email && <InfoRow label="Email" value={request.client_email} />}
                  {request.client_phone && <InfoRow label="Phone" value={request.client_phone} />}
                  {request.requested_due_date && (
                    <InfoRow label="Requested By" value={new Date(request.requested_due_date).toLocaleDateString()} />
                  )}
                  <InfoRow label="Source" value={request.source.replace('_', ' ')} />
                </Section>

                <Section title="Description">
                  <p className="text-sm text-hud-cream-soft whitespace-pre-wrap leading-relaxed">{request.description}</p>
                </Section>

                <Section title="Reviewer">
                  {canManage ? (
                    <select
                      value={request.reviewer_user_id ?? ''}
                      onChange={(e) => e.target.value && handleAssignReviewer(e.target.value)}
                      className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold"
                    >
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  ) : (
                    <InfoRow label="" value={request.reviewer?.name ?? 'Unassigned'} />
                  )}
                </Section>

                <Section
                  title="Internal Assessment"
                  action={canManage ? (
                    <button
                      onClick={() => setShowAssessment(!showAssessment)}
                      className="text-xs text-hud-gold-soft hover:text-hud-gold-soft"
                    >
                      {showAssessment ? 'Cancel' : 'Edit'}
                    </button>
                  ) : undefined}
                >
                  {showAssessment ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs text-hud-cream-dim mb-1">Scope Impact</label>
                        <textarea
                          value={assessment.scope_impact}
                          onChange={(e) => setAssessment((a) => ({ ...a, scope_impact: e.target.value }))}
                          rows={2}
                          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold resize-none"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-hud-cream-dim mb-1">Timeline Impact (days)</label>
                          <input
                            type="number"
                            value={assessment.timeline_impact_days}
                            onChange={(e) => setAssessment((a) => ({ ...a, timeline_impact_days: Number(e.target.value) }))}
                            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-hud-cream-dim mb-1">Cost Impact ($)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={assessment.cost_impact}
                            onChange={(e) => setAssessment((a) => ({ ...a, cost_impact: Number(e.target.value) }))}
                            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-hud-cream-dim mb-1">Internal Summary</label>
                        <textarea
                          value={assessment.internal_summary}
                          onChange={(e) => setAssessment((a) => ({ ...a, internal_summary: e.target.value }))}
                          rows={2}
                          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold resize-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-hud-cream-dim mb-1">Client-Facing Summary</label>
                        <textarea
                          value={assessment.client_summary}
                          onChange={(e) => setAssessment((a) => ({ ...a, client_summary: e.target.value }))}
                          rows={2}
                          placeholder="What the client sees in their portal..."
                          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold resize-none"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-xs text-hud-cream-dim font-medium">Portal Visibility</label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={assessment.cost_impact_visible_to_client}
                            onChange={(e) => setAssessment((a) => ({ ...a, cost_impact_visible_to_client: e.target.checked }))}
                            className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                          />
                          <span className="text-xs text-hud-cream-soft">Show cost impact to client</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={assessment.timeline_impact_visible_to_client}
                            onChange={(e) => setAssessment((a) => ({ ...a, timeline_impact_visible_to_client: e.target.checked }))}
                            className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                          />
                          <span className="text-xs text-hud-cream-soft">Show timeline impact to client</span>
                        </label>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setShowAssessment(false)} className="px-3 py-1.5 text-xs text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg">Cancel</button>
                        <button onClick={handleSaveAssessment} disabled={savingAssessment} className="px-3 py-1.5 text-xs bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg disabled:opacity-50">
                          {savingAssessment ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {request.scope_impact ? (
                        <InfoRow label="Scope" value={request.scope_impact} />
                      ) : null}
                      <div className="flex gap-4">
                        <div className="flex items-center gap-1.5 text-xs">
                          <Clock className="w-3.5 h-3.5 text-hud-cream-dim" />
                          <span className="text-hud-cream-dim">+{request.timeline_impact_days ?? 0} days</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs">
                          <DollarSign className="w-3.5 h-3.5 text-hud-cream-dim" />
                          <span className="text-hud-cream-dim">+${Number(request.cost_impact ?? 0).toLocaleString()}</span>
                        </div>
                      </div>
                      {request.internal_summary && (
                        <p className="text-xs text-hud-cream-dim leading-relaxed">{request.internal_summary}</p>
                      )}
                    </div>
                  )}
                </Section>

                <Section
                  title="Change Order"
                  action={canManage && !activeOrder ? (
                    <button
                      onClick={() => setShowCreateOrder(!showCreateOrder)}
                      className="flex items-center gap-1 text-xs text-hud-gold-soft hover:text-hud-gold-soft"
                    >
                      <Plus className="w-3 h-3" /> Create
                    </button>
                  ) : undefined}
                >
                  {activeOrder ? (
                    <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-white">{activeOrder.title}</p>
                        <OrderStatusBadge status={activeOrder.status} />
                      </div>
                      <div className="flex gap-4 text-xs text-hud-cream-dim">
                        <span>+${Number(activeOrder.cost_amount).toLocaleString()}</span>
                        {activeOrder.timeline_extension_days > 0 && (
                          <span>+{activeOrder.timeline_extension_days}d</span>
                        )}
                      </div>
                      {canManage && activeOrder.status === 'draft' && (
                        <button
                          onClick={() => setSendOrderTarget(activeOrder)}
                          className="w-full mt-2 px-3 py-1.5 bg-hud-gold-deep hover:bg-hud-gold-deep text-white text-xs rounded-lg flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <Send className="w-3.5 h-3.5" /> Send for Signature
                        </button>
                      )}
                      {(activeOrder.status === 'sent' || activeOrder.status === 'viewed') && (
                        <div className="flex items-center gap-1.5 text-xs text-hud-rust">
                          <Clock className="w-3.5 h-3.5" /> Awaiting client signature
                        </div>
                      )}
                      {activeOrder.status === 'signed' && (
                        <div className="flex items-center gap-1.5 text-xs text-hud-emerald">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Signed by {activeOrder.signer_name}
                        </div>
                      )}
                    </div>
                  ) : showCreateOrder ? (
                    <div className="space-y-3">
                      <input
                        value={newOrder.title}
                        onChange={(e) => setNewOrder((o) => ({ ...o, title: e.target.value }))}
                        placeholder="Change order title"
                        className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold"
                      />
                      <textarea
                        value={newOrder.description}
                        onChange={(e) => setNewOrder((o) => ({ ...o, description: e.target.value }))}
                        rows={2}
                        placeholder="Description of changes"
                        className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold resize-none"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-hud-cream-dim mb-1">Cost Amount ($)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={newOrder.cost_amount}
                            onChange={(e) => setNewOrder((o) => ({ ...o, cost_amount: Number(e.target.value) }))}
                            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-hud-cream-dim mb-1">Timeline Extension (days)</label>
                          <input
                            type="number"
                            value={newOrder.timeline_extension_days}
                            onChange={(e) => setNewOrder((o) => ({ ...o, timeline_extension_days: Number(e.target.value) }))}
                            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold"
                          />
                        </div>
                      </div>
                      <textarea
                        value={newOrder.terms_and_conditions}
                        onChange={(e) => setNewOrder((o) => ({ ...o, terms_and_conditions: e.target.value }))}
                        rows={2}
                        placeholder="Terms & conditions (optional)"
                        className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-gold resize-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setShowCreateOrder(false)} className="px-3 py-1.5 text-xs text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg">Cancel</button>
                        <button onClick={handleCreateOrder} disabled={savingOrder || !newOrder.title} className="px-3 py-1.5 text-xs bg-hud-gold-deep hover:bg-hud-gold-deep disabled:opacity-50 text-white rounded-lg">
                          {savingOrder ? 'Creating...' : 'Create Order'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-hud-cream-mute">No change order created yet.</p>
                  )}
                </Section>

                <Section title="Client Portal">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopyPortalLink}
                      className="flex items-center gap-2 px-3 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft hover:text-white text-xs rounded-lg transition-colors"
                    >
                      {copiedPortalLink ? <CheckCircle2 className="w-3.5 h-3.5 text-hud-emerald" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedPortalLink ? 'Copied!' : 'Copy Client Status Link'}
                    </button>
                  </div>
                  <p className="text-xs text-hud-cream-mute mt-2">
                    Share this link with {request.client_name} to let them view the request status and sign any pending change orders.
                  </p>
                </Section>
              </div>
            )}

            {activeTab === 'comments' && (
              <div className="p-6 flex flex-col gap-4">
                <div className="flex gap-2 bg-hud-bg-card rounded-lg p-1 w-fit">
                  {(['internal', 'client'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setCommentTab(t)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                        commentTab === t ? 'bg-hud-bg-elev text-white' : 'text-hud-cream-dim hover:text-white'
                      }`}
                    >
                      {t === 'internal' ? 'Internal Notes' : 'Client-Visible'}
                    </button>
                  ))}
                </div>

                <div className="space-y-3">
                  {filteredComments.length === 0 ? (
                    <p className="text-sm text-hud-cream-mute text-center py-8">
                      No {commentTab === 'internal' ? 'internal notes' : 'client-visible comments'} yet.
                    </p>
                  ) : (
                    filteredComments.map((c) => (
                      <div key={c.id} className="flex gap-3">
                        <div className="w-7 h-7 rounded-full bg-hud-bg-elev flex items-center justify-center flex-none text-xs font-semibold text-hud-cream-soft">
                          {(c.author_name ?? c.author_user?.name ?? 'U').charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 bg-hud-bg-card border border-hud-bg-elev rounded-xl px-3 py-2.5">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium text-white">
                              {c.author_name ?? c.author_user?.name ?? 'Unknown'}
                            </span>
                            {!c.is_internal && (
                              <span className="text-xs bg-hud-gold/20 text-hud-gold-soft px-1.5 py-0.5 rounded-full border border-hud-gold/30">
                                Client Visible
                              </span>
                            )}
                            <span className="text-xs text-hud-cream-mute ml-auto">
                              {new Date(c.created_at).toLocaleDateString()}
                            </span>
                          </div>
                          <p className="text-sm text-hud-cream-soft whitespace-pre-wrap leading-relaxed">{c.body}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {canManage && (
                  <div className="flex flex-col gap-2 mt-2">
                    <textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      rows={2}
                      placeholder={`Add ${commentTab === 'internal' ? 'internal note' : 'client-visible comment'}...`}
                      className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold resize-none"
                    />
                    <div className="flex items-center justify-between">
                      {commentTab === 'internal' && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newCommentClientVisible}
                            onChange={(e) => setNewCommentClientVisible(e.target.checked)}
                            className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                          />
                          <span className="text-xs text-hud-cream-dim">Also visible to client in portal</span>
                        </label>
                      )}
                      {commentTab !== 'internal' && <div />}
                      <button
                        onClick={handleAddComment}
                        disabled={addingComment || !newComment.trim()}
                        className="px-3 py-2 bg-hud-gold-deep hover:bg-hud-gold-deep disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-1.5 text-xs"
                      >
                        <Send className="w-3.5 h-3.5" /> Send
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'audit' && (
              <div className="p-6">
                {auditEvents.length === 0 ? (
                  <p className="text-sm text-hud-cream-mute text-center py-8">No audit events recorded yet.</p>
                ) : (
                  <div className="relative">
                    <div className="absolute left-3.5 top-0 bottom-0 w-px bg-hud-bg-elev" />
                    <div className="space-y-4">
                      {auditEvents.map((ev) => (
                        <div key={ev.id} className="flex gap-3 relative">
                          <div className="w-7 h-7 rounded-full bg-hud-bg-card border border-hud-bg-elev flex items-center justify-center flex-none z-10">
                            <div className="w-2 h-2 rounded-full bg-hud-gold" />
                          </div>
                          <div className="flex-1 pb-1">
                            <p className="text-xs font-medium text-white capitalize">
                              {ev.event_type.replace(/_/g, ' ')}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              {ev.actor_name && (
                                <span className="text-xs text-hud-cream-dim">{ev.actor_name}</span>
                              )}
                              <span className="text-xs text-hud-cream-mute">
                                {new Date(ev.created_at).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div></Portal>

      {showRejectDialog && (
        <Portal><div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowRejectDialog(false)} />
          <div className="relative bg-hud-bg-card border border-hud-bg-elev rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-hud-plum/20 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-hud-plum" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Reject Change Request</h3>
                <p className="text-xs text-hud-cream-dim">Provide a reason for the client</p>
              </div>
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder="Reason for rejection..."
              className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-plum resize-none mb-4"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRejectDialog(false)} className="px-3 py-2 text-sm text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg">Cancel</button>
              <button
                onClick={() => handleTransition('rejected', rejectReason)}
                disabled={transitioning}
                className="px-4 py-2 bg-hud-plum hover:bg-hud-plum disabled:opacity-50 text-white text-sm rounded-lg"
              >
                {transitioning ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div></Portal>
      )}

      {sendOrderTarget && (
        <SendChangeOrderModal
          changeOrder={sendOrderTarget}
          changeRequest={request}
          onClose={() => setSendOrderTarget(null)}
          onSent={async () => {
            setSendOrderTarget(null);
            await onUpdate();
          }}
          currentUserId={currentUserId}
        />
      )}
    </>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-hud-cream-dim uppercase tracking-wide">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 py-1">
      {label && <span className="text-xs text-hud-cream-mute w-20 flex-none">{label}</span>}
      <span className="text-sm text-hud-cream-soft">{value}</span>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: 'bg-hud-cream-mute/20 text-hud-cream-dim',
    sent: 'bg-hud-rust/20 text-hud-rust',
    viewed: 'bg-blue-500/20 text-blue-400',
    signed: 'bg-hud-emerald/20 text-hud-emerald',
    declined: 'bg-hud-plum/20 text-hud-plum',
    voided: 'bg-hud-cream-mute/20 text-hud-cream-mute',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${map[status] ?? ''}`}>
      {status}
    </span>
  );
}
