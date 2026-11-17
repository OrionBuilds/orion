import { useState, useEffect, useCallback } from 'react';
import {
  X,
  User,
  MessageSquare,
  Clock,
  Send,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  FileText,
  Paperclip,
  Download,
  History,
  Eye,
  EyeOff,
} from 'lucide-react';
import type {
  ProjectSupportTicket,
  ProjectSupportTicketComment,
  ProjectSupportTicketAuditEvent,
  User as UserType,
} from '../../types';
import {
  updateSupportTicket,
  getTicketComments,
  addTicketComment,
  getAuditEvents,
} from '../../services/projectSupportTickets';
import { SupportTicketAdminStatusBadge } from './SupportTicketStatusBadge';
import { Portal } from '../shared/Portal';

const CATEGORY_LABELS: Record<string, string> = {
  ai_automation: 'AI Automation System',
  crm_pipeline: 'CRM / Pipeline System',
  content_automation: 'Content Automation Engine',
  integration_api: 'Integration / API System',
  workflow_automation: 'Workflow Automation',
  custom_software: 'Custom Software Development',
  data_analytics: 'Data / Analytics System',
  other: 'Other',
};

const REQUEST_TYPE_LABELS: Record<string, string> = {
  bug_report: 'Bug Report',
  feature_request: 'Feature Request',
  performance_issue: 'Performance Issue',
  configuration_change: 'Configuration Change',
  access_permissions: 'Access / Permissions',
  training_docs: 'Training / Documentation',
  general_inquiry: 'General Inquiry',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-hud-cream-dim',
  medium: 'text-hud-rust',
  high: 'text-orange-400',
  critical: 'text-hud-plum',
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  new: ['in_review', 'in_progress', 'closed'],
  in_review: ['in_progress', 'waiting_on_client', 'resolved', 'closed'],
  in_progress: ['waiting_on_client', 'resolved', 'closed'],
  waiting_on_client: ['in_review', 'in_progress', 'resolved', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

const STATUS_ACTION_LABELS: Record<string, string> = {
  in_review: 'Start Review',
  in_progress: 'Start Work',
  waiting_on_client: 'Wait on Client',
  resolved: 'Mark Resolved',
  closed: 'Close',
};

interface Props {
  ticket: ProjectSupportTicket;
  users: UserType[];
  canManage: boolean;
  currentUserId: string;
  currentUserName: string;
  onClose: () => void;
  onUpdate: () => Promise<void>;
}

export function SupportTicketDrawer({
  ticket: initialTicket,
  users,
  canManage,
  currentUserId,
  currentUserName,
  onClose,
  onUpdate,
}: Props) {
  const [ticket, setTicket] = useState(initialTicket);
  const [comments, setComments] = useState<ProjectSupportTicketComment[]>([]);
  const [auditEvents, setAuditEvents] = useState<ProjectSupportTicketAuditEvent[]>([]);
  const [activeTab, setActiveTab] = useState<'details' | 'comments' | 'audit'>('details');
  const [commentVisibility, setCommentVisibility] = useState<'all' | 'internal' | 'client'>('all');
  const [newComment, setNewComment] = useState('');
  const [isInternalComment, setIsInternalComment] = useState(true);
  const [addingComment, setAddingComment] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [showStatusActions, setShowStatusActions] = useState(false);
  const [resolution, setResolution] = useState(ticket.resolution_summary ?? '');
  const [showResolutionForm, setShowResolutionForm] = useState(false);
  const [savingResolution, setSavingResolution] = useState(false);
  const [assignee, setAssignee] = useState(ticket.assigned_user_id ?? '');

  const loadData = useCallback(async () => {
    const [c, a] = await Promise.all([
      getTicketComments(ticket.id, true),
      getAuditEvents(ticket.id),
    ]);
    setComments(c);
    setAuditEvents(a);
  }, [ticket.id]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleTransition(newStatus: string) {
    setTransitioning(true);
    try {
      const updates: Record<string, unknown> = { status: newStatus };
      if (newStatus === 'resolved' && resolution) {
        updates.resolution_summary = resolution;
        updates.resolved_at = new Date().toISOString();
      }
      const updated = await updateSupportTicket(
        ticket.id,
        updates,
        currentUserId,
        currentUserName
      );
      setTicket(updated);
      await onUpdate();
      await loadData();
      setShowStatusActions(false);
      setShowResolutionForm(false);
    } catch (err) {
      console.error(err);
    } finally {
      setTransitioning(false);
    }
  }

  async function handleAddComment() {
    if (!newComment.trim()) return;
    setAddingComment(true);
    try {
      await addTicketComment({
        supportTicketId: ticket.id,
        orgId: ticket.org_id,
        body: newComment,
        isInternal: isInternalComment,
        authorType: 'user',
        authorUserId: currentUserId,
        authorName: currentUserName,
      });
      setNewComment('');
      await loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setAddingComment(false);
    }
  }

  async function handleAssign(userId: string) {
    try {
      const updated = await updateSupportTicket(
        ticket.id,
        { assigned_user_id: userId || null },
        currentUserId,
        currentUserName
      );
      setTicket(updated);
      setAssignee(userId);
      await onUpdate();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSaveResolution() {
    setSavingResolution(true);
    try {
      const updated = await updateSupportTicket(
        ticket.id,
        {
          resolution_summary: resolution,
          status: 'resolved',
          resolved_at: new Date().toISOString(),
        },
        currentUserId,
        currentUserName
      );
      setTicket(updated);
      setShowResolutionForm(false);
      await onUpdate();
      await loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setSavingResolution(false);
    }
  }

  const allowedTransitions = ALLOWED_TRANSITIONS[ticket.status] ?? [];
  const filteredComments = comments.filter((c) => {
    if (commentVisibility === 'internal') return c.is_internal;
    if (commentVisibility === 'client') return !c.is_internal;
    return true;
  });

  return (
    <Portal><div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="ml-auto relative w-full max-w-2xl bg-hud-bg-mid border-l border-hud-bg-elev flex flex-col h-full overflow-hidden animate-[slideIn_0.2s_ease-out]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev flex-none">
          <div className="flex items-center gap-3 min-w-0">
            <SupportTicketAdminStatusBadge status={ticket.status} />
            <span className="text-xs text-hud-cream-mute font-mono">{ticket.ticket_number}</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-hud-cream-dim hover:text-white rounded-lg hover:bg-hud-bg-elev">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex border-b border-hud-bg-elev flex-none">
          {(['details', 'comments', 'audit'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'text-white border-b-2 border-hud-teal'
                  : 'text-hud-cream-dim hover:text-white'
              }`}
            >
              {tab === 'details' ? 'Details' : tab === 'comments' ? `Messages (${comments.length})` : 'Audit Log'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {activeTab === 'details' && (
            <div className="p-6 space-y-5">
              <div>
                <h2 className="text-base font-semibold text-white mb-1">{ticket.title}</h2>
                <div className="flex items-center gap-3 flex-wrap text-xs text-hud-cream-mute">
                  <span>{CATEGORY_LABELS[ticket.service_category] ?? ticket.service_category}</span>
                  <span className="text-hud-cream-mute">&middot;</span>
                  <span>{REQUEST_TYPE_LABELS[ticket.request_type] ?? ticket.request_type}</span>
                  <span className="text-hud-cream-mute">&middot;</span>
                  <span className={`capitalize font-medium ${PRIORITY_COLORS[ticket.priority]}`}>{ticket.priority}</span>
                  {ticket.severity_score >= 7 && (
                    <>
                      <span className="text-hud-cream-mute">&middot;</span>
                      <span className="text-hud-plum flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Severity {ticket.severity_score}/10
                      </span>
                    </>
                  )}
                </div>
              </div>

              {canManage && (
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <button
                      onClick={() => setShowStatusActions(!showStatusActions)}
                      disabled={allowedTransitions.length === 0 || transitioning}
                      className="flex items-center gap-2 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white hover:bg-hud-bg-elev disabled:opacity-50 transition-colors"
                    >
                      {transitioning ? 'Updating...' : 'Change Status'}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {showStatusActions && (
                      <div className="absolute top-full left-0 mt-1 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-10 min-w-[160px]">
                        {allowedTransitions.map((s) => {
                          if (s === 'resolved') {
                            return (
                              <button
                                key={s}
                                onClick={() => { setShowStatusActions(false); setShowResolutionForm(true); }}
                                className="w-full text-left px-3 py-2 text-sm text-white hover:bg-hud-bg-elev transition-colors"
                              >
                                {STATUS_ACTION_LABELS[s] ?? s}
                              </button>
                            );
                          }
                          return (
                            <button
                              key={s}
                              onClick={() => handleTransition(s)}
                              className="w-full text-left px-3 py-2 text-sm text-white hover:bg-hud-bg-elev transition-colors"
                            >
                              {STATUS_ACTION_LABELS[s] ?? s}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <select
                    value={assignee}
                    onChange={(e) => handleAssign(e.target.value)}
                    className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-teal"
                  >
                    <option value="">Unassigned</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                </div>
              )}

              {showResolutionForm && (
                <div className="bg-hud-bg-card border border-hud-bg-elev rounded-xl p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-white">Resolution Summary</h3>
                  <textarea
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    rows={3}
                    placeholder="Describe how the issue was resolved..."
                    className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white focus:outline-none focus:border-hud-teal resize-none placeholder-hud-cream-dim"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setShowResolutionForm(false)}
                      className="px-3 py-1.5 text-sm text-hud-cream-dim hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveResolution}
                      disabled={savingResolution || !resolution.trim()}
                      className="px-4 py-1.5 bg-hud-emerald-dim hover:bg-hud-emerald disabled:opacity-50 text-white hover:text-hud-bg-deep text-sm rounded-lg"
                    >
                      {savingResolution ? 'Resolving...' : 'Resolve Ticket'}
                    </button>
                  </div>
                </div>
              )}

              <div className="bg-hud-bg-card/60 border border-hud-bg-elev/50 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-semibold text-hud-cream-dim uppercase tracking-wide">Description</h3>
                <p className="text-sm text-hud-cream-soft leading-relaxed whitespace-pre-wrap">{ticket.description}</p>
              </div>

              {ticket.steps_to_reproduce && (
                <div className="bg-hud-bg-card/60 border border-hud-bg-elev/50 rounded-xl p-4 space-y-2">
                  <h3 className="text-xs font-semibold text-hud-cream-dim uppercase tracking-wide">Steps to Reproduce</h3>
                  <p className="text-sm text-hud-cream-soft whitespace-pre-wrap">{ticket.steps_to_reproduce}</p>
                </div>
              )}

              {ticket.error_messages && (
                <div className="bg-hud-plum/20 border border-hud-plum/30 rounded-xl p-4 space-y-2">
                  <h3 className="text-xs font-semibold text-hud-plum uppercase tracking-wide">Error Messages</h3>
                  <pre className="text-xs text-hud-plum/40 whitespace-pre-wrap font-mono">{ticket.error_messages}</pre>
                </div>
              )}

              {ticket.resolution_summary && (
                <div className="bg-hud-emerald-dim/20 border border-hud-emerald-dim/30 rounded-xl p-4 space-y-2">
                  <h3 className="text-xs font-semibold text-hud-emerald uppercase tracking-wide">Resolution</h3>
                  <p className="text-sm text-hud-emerald/40 whitespace-pre-wrap">{ticket.resolution_summary}</p>
                  {ticket.resolved_at && (
                    <p className="text-xs text-hud-emerald">
                      Resolved {new Date(ticket.resolved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <InfoItem label="Submitted by" value={ticket.client_name} />
                <InfoItem label="Email" value={ticket.client_email ?? '—'} />
                <InfoItem label="Affected Area" value={ticket.affected_area ?? '—'} />
                <InfoItem label="Affected Feature" value={ticket.affected_feature ?? '—'} />
                <InfoItem label="Environment" value={ticket.environment ?? '—'} />
                <InfoItem label="Business Impact" value={ticket.business_impact ?? '—'} />
                <InfoItem label="Created" value={new Date(ticket.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} />
                <InfoItem label="Expected Turnaround" value={ticket.expected_turnaround ?? '—'} />
              </div>

              {ticket.attachments?.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Paperclip className="w-3.5 h-3.5 text-hud-cream-mute" />
                    <h3 className="text-xs font-semibold text-hud-cream-dim uppercase tracking-wide">
                      Attachments ({ticket.attachments.length})
                    </h3>
                  </div>
                  {ticket.attachments.map((att, i) => (
                    <a
                      key={i}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg hover:bg-hud-bg-elev transition-colors group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-3.5 h-3.5 text-hud-cream-mute flex-none" />
                        <span className="text-sm text-hud-cream-soft truncate">{att.name}</span>
                        <span className="text-xs text-hud-cream-mute">{(att.size / 1024).toFixed(0)} KB</span>
                      </div>
                      <Download className="w-3.5 h-3.5 text-hud-cream-mute group-hover:text-white" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'comments' && (
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-2">
                {(['all', 'internal', 'client'] as const).map((vis) => (
                  <button
                    key={vis}
                    onClick={() => setCommentVisibility(vis)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      commentVisibility === vis
                        ? 'bg-hud-teal text-hud-bg-deep'
                        : 'bg-hud-bg-card text-hud-cream-dim hover:text-white'
                    }`}
                  >
                    {vis === 'all' ? 'All' : vis === 'internal' ? 'Internal Only' : 'Client Visible'}
                  </button>
                ))}
              </div>

              {filteredComments.length === 0 ? (
                <p className="text-sm text-hud-cream-mute text-center py-6">No messages yet.</p>
              ) : (
                <div className="space-y-3">
                  {filteredComments.map((c) => (
                    <div key={c.id} className="bg-hud-bg-card/60 border border-hud-bg-elev/50 rounded-xl px-4 py-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                            c.author_type === 'client' ? 'bg-hud-teal text-hud-bg-deep' :
                            c.author_type === 'system' ? 'bg-hud-cream-mute text-hud-cream-soft' :
                            'bg-hud-gold-deep text-white'
                          }`}>
                            {(c.author_name ?? 'S').charAt(0).toUpperCase()}
                          </div>
                          <span className="text-sm font-medium text-white">{c.author_name ?? 'System'}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            c.author_type === 'client' ? 'bg-hud-teal/20 text-hud-teal' :
                            c.author_type === 'system' ? 'bg-hud-cream-mute/20 text-hud-cream-dim' :
                            'bg-hud-gold/20 text-hud-gold-soft'
                          }`}>
                            {c.author_type}
                          </span>
                          {c.is_internal && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-hud-rust/20 text-hud-rust flex items-center gap-1">
                              <EyeOff className="w-2.5 h-2.5" /> Internal
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-hud-cream-mute">
                          {new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {' '}
                          {new Date(c.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm text-hud-cream-soft whitespace-pre-wrap">{c.body}</p>
                    </div>
                  ))}
                </div>
              )}

              {canManage && (
                <div className="space-y-2 pt-2 border-t border-hud-bg-elev">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setIsInternalComment(true)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                        isInternalComment ? 'bg-hud-rust/20 text-hud-rust' : 'bg-hud-bg-card text-hud-cream-mute hover:text-hud-cream-soft'
                      }`}
                    >
                      <EyeOff className="w-3 h-3" /> Internal Note
                    </button>
                    <button
                      onClick={() => setIsInternalComment(false)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                        !isInternalComment ? 'bg-hud-teal/20 text-hud-teal' : 'bg-hud-bg-card text-hud-cream-mute hover:text-hud-cream-soft'
                      }`}
                    >
                      <Eye className="w-3 h-3" /> Client Visible
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment(); }
                      }}
                      rows={2}
                      placeholder={isInternalComment ? 'Add an internal note...' : 'Reply to client...'}
                      className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-teal resize-none"
                    />
                    <button
                      onClick={handleAddComment}
                      disabled={addingComment || !newComment.trim()}
                      className="px-3 py-2 bg-hud-teal hover:bg-hud-teal disabled:opacity-50 text-hud-bg-deep rounded-lg self-end transition-colors"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                  {!isInternalComment && (
                    <p className="text-xs text-hud-teal">This message will be visible to the client in their portal.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="p-6 space-y-3">
              {auditEvents.length === 0 ? (
                <p className="text-sm text-hud-cream-mute text-center py-6">No audit events recorded.</p>
              ) : (
                <div className="space-y-2">
                  {auditEvents.map((evt) => (
                    <div key={evt.id} className="flex items-start gap-3 px-3 py-2.5 bg-hud-bg-card/40 rounded-lg">
                      <History className="w-3.5 h-3.5 text-hud-cream-mute mt-0.5 flex-none" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-hud-cream-soft">{formatAuditEvent(evt)}</p>
                        <p className="text-xs text-hud-cream-mute mt-0.5">
                          {evt.actor_name ?? 'System'} &middot;{' '}
                          {new Date(evt.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                          {new Date(evt.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div></Portal>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-hud-bg-card/40 rounded-lg px-3 py-2">
      <span className="text-xs text-hud-cream-mute block">{label}</span>
      <span className="text-sm text-hud-cream-soft capitalize">{value}</span>
    </div>
  );
}

function formatAuditEvent(evt: ProjectSupportTicketAuditEvent): string {
  const meta = evt.metadata as Record<string, unknown> | null;
  switch (evt.event_type) {
    case 'status_changed':
      return `Status changed from "${meta?.from ?? '—'}" to "${meta?.to ?? '—'}"`;
    case 'assigned':
      return `Assigned to ${meta?.assignee_name ?? 'someone'}`;
    case 'comment_added':
      return `${meta?.is_internal ? 'Internal note' : 'Client message'} added`;
    case 'created':
      return 'Ticket created';
    case 'resolved':
      return 'Ticket resolved';
    default:
      return evt.event_type.replace(/_/g, ' ');
  }
}
