import { draftPreview } from '../../lib/approvalPreview';
import React, { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Clock, AlertTriangle, ChevronLeft, ChevronRight, Search, Filter, Eye, MessageSquare, Bot } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getApprovalQueue, approveItem, rejectItem, getPendingApprovalCount } from '../../services/workflowApprovals';
import type { ApprovalQueueItem, ApprovalFilters } from '../../services/workflowApprovals';
import { useToast } from '../../contexts/ToastContext';
import { Portal } from '../../components/shared/Portal';
import { ClaraDraftEditor } from '../../components/meetings/ClaraDraftEditor';

/** Human-friendly agent name for agent-sourced rows, or null for legacy workflow rows. */
function agentDisplayName(item: ApprovalQueueItem): string | null {
  if (item.source === 'agent_approval' && item.agent_slug) {
    return item.agent_slug.charAt(0).toUpperCase() + item.agent_slug.slice(1);
  }
  if (item.source === 'agent_run' && item.agent_run?.agent?.name) {
    return item.agent_run.agent.name;
  }
  return null;
}

/** draft_content carries a self-assessed risk level for agent-originated actions. */
function extractRisk(draftContent: unknown): string | null {
  if (draftContent && typeof draftContent === 'object' && 'risk' in draftContent) {
    const risk = (draftContent as Record<string, unknown>).risk;
    return typeof risk === 'string' ? risk : null;
  }
  return null;
}

const riskColors: Record<string, string> = {
  low: 'bg-hud-bg-elev/50 text-hud-cream-soft',
  medium: 'bg-hud-rust/20 text-hud-rust/40',
  high: 'bg-hud-plum/20 text-hud-plum/40',
};

export default function AutomationApprovals() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const orgId = user?.organization_id || '';

  const [items, setItems] = useState<ApprovalQueueItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<ApprovalFilters>({ status: ['pending_approval'] });
  const [search, setSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<ApprovalQueueItem | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [processing, setProcessing] = useState<string | null>(null);

  const perPage = 20;

  const loadData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [queueResult, count] = await Promise.all([
        getApprovalQueue(orgId, { ...filters, search: search || undefined }, page, perPage),
        getPendingApprovalCount(orgId),
      ]);
      setItems(queueResult.data);
      setTotalCount(queueResult.count);
      setPendingCount(count);
    } catch {
      showToast('error', 'Failed to load approval queue');
    } finally {
      setLoading(false);
    }
  }, [orgId, filters, search, page, showToast]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleApprove(id: string) {
    if (!user?.id) return;
    setProcessing(id);
    try {
      await approveItem(id, user.id, actionNote || undefined);
      showToast('success', 'Item approved');
      setSelectedItem(null);
      setActionNote('');
      loadData();
    } catch {
      showToast('error', 'Failed to approve item');
    } finally {
      setProcessing(null);
    }
  }

  async function handleReject(id: string) {
    if (!user?.id) return;
    setProcessing(id);
    try {
      await rejectItem(id, user.id, actionNote || undefined);
      showToast('success', 'Item rejected');
      setSelectedItem(null);
      setActionNote('');
      loadData();
    } catch {
      showToast('error', 'Failed to reject item');
    } finally {
      setProcessing(null);
    }
  }

  const totalPages = Math.ceil(totalCount / perPage);

  const statusColors: Record<string, string> = {
    pending: 'bg-hud-rust/20 text-hud-rust/40',
    approved: 'bg-hud-emerald/20 text-hud-emerald/40',
    rejected: 'bg-hud-plum/20 text-hud-plum/40',
    expired: 'bg-hud-bg-elev/50 text-hud-cream-dim',
    escalated: 'bg-orange-500/20 text-orange-300',
    superseded: 'bg-hud-bg-elev/50 text-hud-cream-dim',
  };

  const statusTabs = [
    { key: 'pending_approval', label: 'Pending', icon: Clock },
    { key: 'approved', label: 'Approved', icon: CheckCircle },
    { key: 'rejected', label: 'Rejected', icon: XCircle },
    { key: 'all', label: 'All', icon: Filter },
  ];

  function formatDraftContent(content: unknown): string {
    if (!content) return 'No content';
    if (typeof content === 'string') return content;
    if (typeof content === 'object') return JSON.stringify(content, null, 2);
    return String(content);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Approval Queue</h2>
          <p className="text-sm text-hud-cream-dim mt-1">
            Review and approve actions before your AI agents carry them out
          </p>
        </div>
        {pendingCount > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 bg-hud-rust/10 border border-hud-rust/30 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-hud-rust" />
            <span className="text-sm font-medium text-hud-rust/40">
              {pendingCount} pending approval{pendingCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex bg-hud-bg-card rounded-lg p-1">
          {statusTabs.map((tab) => {
            const isActive = tab.key === 'all'
              ? !filters.status || filters.status.length === 0
              : filters.status?.length === 1 && filters.status[0] === tab.key;
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setFilters({ ...filters, status: tab.key === 'all' ? [] : [tab.key] })}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-hud-bg-elev text-white shadow-sm'
                    : 'text-hud-cream-dim hover:text-hud-cream-soft'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="relative w-full sm:flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
          <input
            type="text"
            placeholder="Search by request or contact..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-hud-gold border-t-transparent rounded-full animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
          <CheckCircle className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
          <h3 className="text-lg font-medium text-white mb-1">All caught up</h3>
          <p className="text-sm text-hud-cream-dim">No items match the current filters</p>
        </div>
      ) : (
        <>
          {/*
            Mobile: cards. This is the decide surface — the screen you open on a phone precisely
            because you are away from the desk — and a six-column table cannot show Approve/Reject
            at 390px. It used to be `overflow-hidden` (not `overflow-x-auto`), so the row
            compressed instead of scrolling and the right-aligned action buttons were exactly what
            got clipped: the one control the page exists for was the one you could not reach.

            Cards rather than a scroll wrapper, because horizontal scrolling on every row to reach
            Approve is technically reachable and practically unusable. The buttons here are also
            full-width labelled targets rather than 14px icons, which is what a decision made on a
            phone deserves.
          */}
          <div className="md:hidden space-y-3">
            {items.map((item) => {
              const agentName = agentDisplayName(item);
              const risk = extractRisk(item.draft_content);
              return (
                <div key={item.id} className="bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      {agentName ? (
                        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-hud-gold-soft">
                          <Bot className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{agentName}</span>
                        </span>
                      ) : (
                        <span className="text-sm font-medium text-white break-words">
                          {item.title || 'Approval request'}
                        </span>
                      )}
                      <div className="text-xs text-hud-cream-dim mt-0.5">
                        {item.contact ? `${item.contact.first_name} ${item.contact.last_name}` : 'No contact'}
                      </div>
                    </div>
                    <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColors[item.status] || 'bg-hud-bg-elev/50 text-hud-cream-soft'}`}>
                      {item.status}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 mb-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-hud-gold/20 text-hud-gold-soft">
                      {(item.action_type || '').replace(/_/g, ' ')}
                    </span>
                    {risk && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${riskColors[risk] || 'bg-hud-bg-elev/50 text-hud-cream-soft'}`}>
                        {risk} risk
                      </span>
                    )}
                    <span className="text-xs text-hud-cream-dim ml-auto">
                      {new Date(item.requested_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {(() => {
                    const pv = draftPreview(item.draft_content);
                    return pv ? (
                      <div className="mb-3 rounded-md bg-hud-bg-mid/60 border border-hud-bg-elev px-3 py-2" data-testid="draft-preview">
                        {pv.to && <p className="text-xs text-hud-cream-dim truncate">To: <span className="text-hud-cream-soft">{pv.to}</span></p>}
                        {pv.subject && <p className="text-sm font-medium text-white mt-0.5 break-words">{pv.subject}</p>}
                        {pv.snippet && <p className="text-xs text-hud-cream-soft mt-1 line-clamp-4 break-words">{pv.snippet}</p>}
                      </div>
                    ) : null;
                  })()}

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setSelectedItem(item); setActionNote(''); }}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-hud-cream-soft border border-hud-cream-mute rounded-md hover:bg-hud-bg-elev"
                    >
                      <Eye className="w-4 h-4" /> Details
                    </button>
                    {item.status === 'pending_approval' && (
                      <>
                        <button
                          onClick={() => handleApprove(item.id)}
                          disabled={processing === item.id}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-hud-emerald/40 bg-hud-emerald/10 border border-hud-emerald/30 rounded-md hover:bg-hud-emerald/20 disabled:opacity-50"
                        >
                          <CheckCircle className="w-4 h-4" /> Approve
                        </button>
                        <button
                          onClick={() => handleReject(item.id)}
                          disabled={processing === item.id}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-hud-plum/40 bg-hud-plum/10 border border-hud-plum/30 rounded-md hover:bg-hud-plum/20 disabled:opacity-50"
                        >
                          <XCircle className="w-4 h-4" /> Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop: the table, now with a scroll wrapper instead of overflow-hidden. */}
          <div className="hidden md:block bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-hud-bg-elev">
                  <th className="text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider px-4 py-3">Request / Agent</th>
                  <th className="text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider px-4 py-3">Contact</th>
                  <th className="text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider px-4 py-3">Action</th>
                  <th className="text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider px-4 py-3">Status</th>
                  <th className="text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider px-4 py-3">Requested</th>
                  <th className="text-right text-xs font-medium text-hud-cream-dim uppercase tracking-wider px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hud-bg-elev/50">
                {items.map((item) => {
                  const agentName = agentDisplayName(item);
                  const risk = extractRisk(item.draft_content);
                  return (
                    <tr key={item.id} className="hover:bg-hud-bg-elev/30 transition-colors">
                      <td className="px-4 py-3">
                        {agentName ? (
                          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-hud-gold-soft">
                            <Bot className="w-3.5 h-3.5" />
                            {agentName}
                            {risk && (
                              <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${riskColors[risk] || 'bg-hud-bg-elev/50 text-hud-cream-soft'}`}>
                                {risk} risk
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-sm font-medium text-white">
                            {item.title || 'Approval request'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-hud-cream-soft">
                          {item.contact
                            ? `${item.contact.first_name} ${item.contact.last_name}`
                            : 'N/A'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-hud-gold/20 text-hud-gold-soft">
                          {(item.action_type || '').replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColors[item.status] || 'bg-hud-bg-elev/50 text-hud-cream-soft'}`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-hud-cream-dim">
                          {new Date(item.requested_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => { setSelectedItem(item); setActionNote(''); }}
                            className="p-1.5 text-hud-cream-dim hover:text-hud-cream-soft rounded-md hover:bg-hud-bg-elev"
                            title="View details"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {item.status === 'pending_approval' && (
                            <>
                              <button
                                onClick={() => handleApprove(item.id)}
                                disabled={processing === item.id}
                                className="p-1.5 text-hud-emerald rounded-md hover:bg-hud-emerald/10 disabled:opacity-50"
                                title="Approve"
                              >
                                <CheckCircle className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleReject(item.id)}
                                disabled={processing === item.id}
                                className="p-1.5 text-hud-plum rounded-md hover:bg-hud-plum/10 disabled:opacity-50"
                                title="Reject"
                              >
                                <XCircle className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-hud-cream-dim">
                Showing {(page - 1) * perPage + 1}--{Math.min(page * perPage, totalCount)} of {totalCount}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-1.5 rounded-md hover:bg-hud-bg-elev disabled:opacity-50"
                >
                  <ChevronLeft className="w-4 h-4 text-hud-cream-soft" />
                </button>
                <span className="text-sm text-hud-cream-soft px-2">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="p-1.5 rounded-md hover:bg-hud-bg-elev disabled:opacity-50"
                >
                  <ChevronRight className="w-4 h-4 text-hud-cream-soft" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedItem && (() => {
        const agentName = agentDisplayName(selectedItem);
        const risk = extractRisk(selectedItem.draft_content);
        const subtitleLead = agentName ?? selectedItem.title;
        return (
          <Portal><div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedItem(null)}>
            <div
              className="bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-2xl w-full max-w-2xl max-h-[85dvh] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
                <div>
                  <h3 className="text-lg font-semibold text-white">Approval Details</h3>
                  <p className="text-sm text-hud-cream-dim mt-0.5 flex items-center gap-1.5">
                    {agentName && <Bot className="w-3.5 h-3.5 text-hud-gold-soft" />}
                    {subtitleLead ? `${subtitleLead} — ` : ''}
                    {(selectedItem.action_type || '').replace(/_/g, ' ')}
                    {risk && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${riskColors[risk] || 'bg-hud-bg-elev/50 text-hud-cream-soft'}`}>
                        {risk} risk
                      </span>
                    )}
                  </p>
                </div>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[selectedItem.status] || 'bg-hud-bg-elev/50 text-hud-cream-soft'}`}>
                  {selectedItem.status}
                </span>
              </div>

              <div className="px-6 py-4 overflow-y-auto max-h-[50dvh] space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Contact</label>
                    <p className="text-sm text-white mt-1">
                      {selectedItem.contact
                        ? `${selectedItem.contact.first_name} ${selectedItem.contact.last_name}`
                        : 'N/A'}
                    </p>
                    {selectedItem.contact?.email && (
                      <p className="text-xs text-hud-cream-dim">{selectedItem.contact.email}</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Requested</label>
                    <p className="text-sm text-white mt-1">
                      {new Date(selectedItem.requested_at).toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* The agent's own explanation of what it wants to do and why. It was not rendered
                    anywhere, so an approver saw a raw JSON payload and had to infer the intent
                    from it — the one field written specifically to be read by the person
                    deciding. It goes above the payload for that reason. */}
                {selectedItem.description && (
                  <div>
                    <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">What this does</label>
                    <p className="mt-2 text-sm text-hud-cream-soft whitespace-pre-wrap leading-relaxed">
                      {selectedItem.description}
                    </p>
                  </div>
                )}

                {/* A pending Clara email/text (e.g. a post-meeting recap) is editable before the decision. */}
                <ClaraDraftEditor
                  key={selectedItem.id}
                  item={selectedItem}
                  onSaved={(draftContent) => {
                    setSelectedItem({ ...selectedItem, draft_content: draftContent });
                    setItems((prev) => prev.map((it) => (it.id === selectedItem.id ? { ...it, draft_content: draftContent } : it)));
                    showToast('success', 'Draft saved');
                  }}
                  onError={(msg) => showToast('error', msg)}
                />

                {/* runtime-validated JSON payload; cast for JSX rendering only */}
                {(selectedItem.draft_content && (
                  <div>
                    <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Draft Content</label>
                    <pre className="mt-2 p-3 bg-hud-bg-mid rounded-lg text-sm text-hud-cream-soft whitespace-pre-wrap overflow-x-auto border border-hud-bg-elev">
                      {formatDraftContent(selectedItem.draft_content)}
                    </pre>
                  </div>
                )) as React.ReactNode}

                {selectedItem.resolved_at && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Resolved At</label>
                      <p className="text-sm text-white mt-1">
                        {new Date(selectedItem.resolved_at).toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Resolved By</label>
                      <p className="text-sm text-white mt-1">
                        {selectedItem.resolved_by?.name
                          || (agentName ? `${agentName} (mirrored)` : null)
                          || 'Unknown'}
                      </p>
                    </div>
                  </div>
                )}

                {selectedItem.resolution_note && (
                  <div>
                    <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Resolution Note</label>
                    <p className="text-sm text-hud-cream-soft mt-1">{selectedItem.resolution_note}</p>
                  </div>
                )}

                {selectedItem.status === 'pending_approval' && (
                  <div>
                    <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Note (optional)</label>
                    <div className="relative mt-1">
                      <MessageSquare className="absolute left-3 top-3 w-4 h-4 text-hud-cream-mute" />
                      <textarea
                        value={actionNote}
                        onChange={(e) => setActionNote(e.target.value)}
                        placeholder="Add a note about your decision..."
                        rows={3}
                        className="w-full pl-9 pr-4 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50 resize-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-hud-bg-elev bg-hud-bg-card/50">
                <button
                  onClick={() => setSelectedItem(null)}
                  className="px-4 py-2 text-sm font-medium text-hud-cream-soft bg-hud-bg-elev border border-hud-cream-mute rounded-lg hover:bg-hud-cream-mute transition-colors"
                >
                  Close
                </button>
                {selectedItem.status === 'pending_approval' && (
                  <>
                    <button
                      onClick={() => handleReject(selectedItem.id)}
                      disabled={processing === selectedItem.id}
                      className="px-4 py-2 text-sm font-medium text-hud-plum/40 bg-hud-plum/10 border border-hud-plum/30 rounded-lg hover:bg-hud-plum/20 transition-colors disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleApprove(selectedItem.id)}
                      disabled={processing === selectedItem.id}
                      className="px-4 py-2 text-sm font-medium text-white hover:text-hud-bg-deep bg-hud-emerald-dim rounded-lg hover:bg-hud-emerald transition-colors disabled:opacity-50"
                    >
                      Approve
                    </button>
                  </>
                )}
              </div>
            </div>
          </div></Portal>
        );
      })()}
    </div>
  );
}
