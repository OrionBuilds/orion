import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useInTabbedModule } from '../../hooks/useInTabbedModule';
import { getProposals, getProposalStats, deleteProposal, deleteProposals, sendProposal, updateProposal } from '../../services/proposals';
import type { Proposal, ProposalStats, ProposalStatus } from '../../types';
import {
  FileText,
  FileDown,
  Plus,
  Search,
  Filter,
  MoreVertical,
  Send,
  Eye,
  Trash2,
  Loader2,
  CheckCircle2,
  Clock,
  XCircle,
  AlertCircle,
  DollarSign,
  Calendar,
  User,
  Sparkles,
  ChevronDown,
  ExternalLink,
  Copy,
  PenTool,
  Ban,
} from 'lucide-react';
import { CreateProposalModal } from '../../components/proposals/CreateProposalModal';
import { exportProposalToPDF } from '../../services/proposalPdfExport';
import { getBrandKits } from '../../services/brandboard';
import { extractValueFromSections } from '../../utils/extractProposalValue';
import { formatCurrency, formatDateNumeric } from '../../utils/formatters';
import { logError } from '../../lib/errors';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';
import { formerContactLabel } from '../../utils/formerContact';

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: typeof Clock; label: string }> = {
  draft: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-soft', icon: Clock, label: 'Draft' },
  sent: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', icon: Send, label: 'Sent' },
  viewed: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', icon: Eye, label: 'Viewed' },
  accepted: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: CheckCircle2, label: 'Accepted' },
  rejected: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', icon: XCircle, label: 'Rejected' },
  expired: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', icon: AlertCircle, label: 'Expired' },
};

const SIGNATURE_STATUS_STYLES: Record<string, { bg: string; text: string; icon: typeof PenTool; label: string }> = {
  pending_signature: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', icon: PenTool, label: 'Awaiting Signature' },
  viewed: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', icon: Eye, label: 'Viewed by Signer' },
  signed: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: PenTool, label: 'Signed' },
  declined: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', icon: Ban, label: 'Declined' },
  voided: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-dim', icon: Ban, label: 'Voided' },
};

export function Proposals() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, hasPermission } = useAuth();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [stats, setStats] = useState<ProposalStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProposalStatus | 'all'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const pageSize = 25;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);

  // Deep link from SAM.gov “Generate Response”:
  // /proposals?new=true&opportunity_id=...&contact_id=...&source=sam_gov
  const [preselectedOpportunityId, setPreselectedOpportunityId] = useState<string | undefined>();
  const [preselectedContactId, setPreselectedContactId] = useState<string | undefined>();

  /** Drops the deep-link params so the modal doesn't reopen on re-render. */
  const clearCreateParams = () => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    for (const key of ['new', 'opportunity_id', 'contact_id', 'source']) {
      if (next.has(key)) {
        next.delete(key);
        changed = true;
      }
    }
    if (changed) setSearchParams(next, { replace: true });
  };

  // The params are consumed into state and dropped as soon as the modal opens: clearing them
  // later would replace whatever entry the modal pushed on its way to the builder.
  useEffect(() => {
    if (searchParams.get('new') !== 'true') return;
    setPreselectedOpportunityId(searchParams.get('opportunity_id') ?? undefined);
    setPreselectedContactId(searchParams.get('contact_id') ?? undefined);
    setShowCreateModal(true);
    clearCreateParams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const canView = hasPermission('proposals.view');
  const canCreate = hasPermission('proposals.create');
  const inTabbedModule = useInTabbedModule();
  const canEdit = hasPermission('proposals.edit');
  const canSend = hasPermission('proposals.send');
  const canDelete = hasPermission('proposals.delete');

  useEffect(() => {
    if (canView) {
      loadData();
    }
  }, [user, canView, page, statusFilter, searchQuery]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const filters: { status?: ProposalStatus[]; search?: string } = {};

      if (statusFilter !== 'all') {
        filters.status = [statusFilter];
      }
      if (searchQuery) {
        filters.search = searchQuery;
      }

      const [proposalData, statsData] = await Promise.all([
        getProposals(filters, page, pageSize),
        getProposalStats(),
      ]);

      setProposals(proposalData.data);
      setTotalCount(proposalData.total);
      setStats(statsData);

      const needsBackfill = proposalData.data.filter(p => !p.total_value || p.total_value === 0);
      if (needsBackfill.length > 0) {
        (async () => {
          let didUpdate = false;
          for (const p of needsBackfill) {
            const extracted = extractValueFromSections(p.sections, p.currency);
            if (extracted && extracted.value > 0) {
              try {
                // BUG FIX (flagged): updateProposal requires an actorUserId; it was previously
                // omitted, so backfill activity entries were logged with an undefined actor.
                await updateProposal(p.id, { total_value: extracted.value, currency: extracted.currency }, user?.id ?? '');
                didUpdate = true;
              } catch (err) {
                logError('Proposals.backfillProposalValues', err);
              }
            }
          }
          if (didUpdate) {
            const refreshed = await getProposalStats();
            setStats(refreshed);
          }
        })();
      }
    } catch (err) {
      console.error('Failed to load proposals:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendProposal = async (proposal: Proposal) => {
    if (!user) return;
    try {
      await sendProposal(proposal.id, user.id);
      loadData();
    } catch (err) {
      console.error('Failed to send proposal:', err);
    }
    setActionMenuId(null);
  };

  const handleDeleteProposal = async (proposal: Proposal) => {
    if (!confirm('Are you sure you want to delete this proposal?')) return;
    try {
      await deleteProposal(proposal.id);
      loadData();
    } catch (err) {
      console.error('Failed to delete proposal:', err);
    }
    setActionMenuId(null);
  };

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(new Set(proposals.map(p => p.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelect = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedIds.size} proposals?`)) return;
    setIsDeleting(true);
    try {
      await deleteProposals(Array.from(selectedIds));
      setSelectedIds(new Set());
      loadData();
    } catch (err) {
      console.error('Failed to delete proposals:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const copyPublicLink = (token: string) => {
    const url = `${window.location.origin}/p/${token}`;
    navigator.clipboard.writeText(url);
  };

  const handleExportPDF = async (proposal: Proposal) => {
    try {
      setExportingId(proposal.id);
      setActionMenuId(null);
      let brandKit = null;
      try {
        const kits = await getBrandKits(proposal.org_id, { active: true });
        if (kits.length > 0) brandKit = kits[0];
      } catch (err) {
        logError('Proposals.handleExportPDF', err);
      }
      await exportProposalToPDF(proposal, brandKit);
    } catch (err) {
      console.error('Failed to export PDF:', err);
      alert('Failed to open print window. Please allow popups for this site.');
    } finally {
      setExportingId(null);
    }
  };

  const getContactName = (proposal: Proposal) => {
    if (!proposal.contact) return formerContactLabel(proposal.former_contact) ?? 'Unknown';
    return proposal.contact.company || `${proposal.contact.first_name} ${proposal.contact.last_name}`;
  };

  const getProposalDisplayValue = (proposal: Proposal): { value: number; isRange: boolean; minValue: number } => {
    const items = proposal.line_items || [];
    if (items.length > 0) {
      let totalMin = 0;
      let totalMax = 0;
      let hasRange = false;
      for (const item of items) {
        const effectiveMin = item.unit_price;
        const effectiveMax = item.unit_price_max != null && item.unit_price_max > item.unit_price ? item.unit_price_max : item.unit_price;
        if (effectiveMax > effectiveMin) hasRange = true;
        const discount = item.discount_percent / 100;
        totalMin += item.quantity * effectiveMin * (1 - discount);
        totalMax += item.quantity * effectiveMax * (1 - discount);
      }
      return { value: totalMax, isRange: hasRange, minValue: totalMin };
    }

    if (proposal.total_value > 0) {
      return { value: proposal.total_value, isRange: false, minValue: proposal.total_value };
    }

    const extracted = extractValueFromSections(proposal.sections, proposal.currency);
    if (extracted && extracted.value > 0) {
      return { value: extracted.value, isRange: false, minValue: extracted.value };
    }

    return { value: 0, isRange: false, minValue: 0 };
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  if (!canView) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-hud-cream-dim">You don't have permission to view proposals.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-hud-bg-elev/50">
        {(!inTabbedModule || canCreate) && (
        <div className={`flex items-center mb-6 ${inTabbedModule ? 'justify-end' : 'justify-between'}`}>
          {!inTabbedModule && (
            <div>
              <h1 className="text-2xl font-semibold text-white flex items-center gap-3">
                <FileText className="w-7 h-7 text-hud-gold-soft" />
                Proposals
              </h1>
              <p className="text-hud-cream-dim mt-1">Create and manage client proposals with AI-powered generation</p>
            </div>
          )}
          {canCreate && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Proposal
            </button>
          )}
        </div>
        )}

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-cream-dim text-sm mb-1">
                <FileText className="w-4 h-4" />
                Total
              </div>
              <p className="text-2xl font-semibold text-white">{stats.totalProposals}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-cream-dim text-sm mb-1">
                <Clock className="w-4 h-4" />
                Drafts
              </div>
              <p className="text-2xl font-semibold text-hud-cream-soft">{stats.draftCount}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-gold-soft text-sm mb-1">
                <Send className="w-4 h-4" />
                Sent
              </div>
              <p className="text-2xl font-semibold text-hud-gold-soft">{stats.sentCount}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-emerald text-sm mb-1">
                <CheckCircle2 className="w-4 h-4" />
                Accepted
              </div>
              <p className="text-2xl font-semibold text-hud-emerald/40">{stats.acceptedCount}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-cream-dim text-sm mb-1">
                <DollarSign className="w-4 h-4" />
                Total Value
              </div>
              <p className="text-2xl font-semibold text-white">{formatCurrency(stats.totalValue)}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-emerald text-sm mb-1">
                <Sparkles className="w-4 h-4" />
                Win Rate
              </div>
              <p className="text-2xl font-semibold text-hud-emerald/40">{stats.conversionRate.toFixed(1)}%</p>
            </div>
            {/* interface lacks an index signature; runtime object is a plain row — fresh spread keeps the defensive undefined check */}
            {({ ...stats } as Record<string, unknown>).signedCount !== undefined && (
              <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
                <div className="flex items-center gap-2 text-hud-teal text-sm mb-1">
                  <PenTool className="w-4 h-4" />
                  Signed
                </div>
                {/* interface lacks an index signature; runtime object is a plain row — fresh spread, value read immediately */}
                <p className="text-2xl font-semibold text-hud-teal">{String(({ ...stats } as Record<string, unknown>).signedCount)}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-6 py-4 flex items-center gap-4 border-b border-hud-bg-elev/50">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
          <input
            type="text"
            placeholder="Search proposals..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
          />
        </div>

        <div className="relative">
          <button className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft hover:bg-hud-bg-elev transition-colors">
            <Filter className="w-4 h-4" />
            Status
            <ChevronDown className="w-4 h-4" />
          </button>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ProposalStatus | 'all')}
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="viewed">Viewed</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
          </div>
        ) : proposals.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-hud-cream-dim">
            <FileText className="w-12 h-12 mb-4 opacity-50" />
            <p>No proposals found</p>
            {canCreate && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="mt-4 text-hud-gold-soft hover:text-hud-gold-soft flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Create your first proposal
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {selectedIds.size > 0 && (
              <div className="bg-hud-bg-card/95 border-b border-hud-gold-deep/50 px-6 py-3 flex items-center justify-between sticky top-0 z-20 backdrop-blur-sm shadow-sm ring-1 ring-inset ring-hud-gold/20">
                <span className="text-hud-gold/15 font-medium">
                  {selectedIds.size} {selectedIds.size === 1 ? 'proposal' : 'proposals'} selected
                </span>
                <div className="flex gap-3">
                  {canDelete && (
                    <button
                      onClick={handleBulkDelete}
                      disabled={isDeleting}
                      className="flex items-center gap-2 px-3 py-1.5 bg-hud-plum/10 text-hud-plum hover:bg-hud-plum/20 rounded-lg transition-colors border border-hud-plum/20 font-medium text-sm disabled:opacity-50"
                    >
                      {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      Delete Selected
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead className={`bg-hud-bg-card/95 sticky ${selectedIds.size > 0 ? 'top-[53px]' : 'top-0'} z-10 backdrop-blur-sm`}>
                <tr>
                  <th className="w-12 px-6 py-3 text-left">
                    <input
                      type="checkbox"
                      checked={proposals.length > 0 && selectedIds.size === proposals.length}
                      onChange={handleSelectAll}
                      className="w-4 h-4 rounded border-hud-bg-elev bg-hud-bg-card text-hud-gold focus:ring-hud-gold/50"
                    />
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Proposal
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Client
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Value
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Valid Until
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Created
                </th>
                <th className="text-right px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-bg-elev/50">
              {proposals.map((proposal) => {
                const statusStyle = STATUS_STYLES[proposal.status];
                const StatusIcon = statusStyle.icon;

                return (
                  <tr
                    key={proposal.id}
                    onClick={() => navigate(`/proposals/${proposal.id}`)}
                    className={`cursor-pointer transition-colors ${selectedIds.has(proposal.id) ? 'bg-hud-gold-deep/20 hover:bg-hud-gold-deep/30' : 'hover:bg-hud-bg-card/30'}`}
                  >
                    <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(proposal.id)}
                        onChange={() => handleSelect(proposal.id)}
                        className="w-4 h-4 rounded border-hud-bg-elev bg-hud-bg-card text-hud-gold focus:ring-hud-gold/50"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-hud-gold/20 flex items-center justify-center">
                          <FileText className="w-5 h-5 text-hud-gold-soft" />
                        </div>
                        <div>
                          <p className="text-white font-medium">{proposal.title}</p>
                          {proposal.ai_context?.generated_at && (
                            <span className="inline-flex items-center gap-1 text-xs text-hud-gold-soft">
                              <Sparkles className="w-3 h-3" />
                              AI Generated
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-hud-cream-dim" />
                        <span className="text-hud-cream-soft">{getContactName(proposal)}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        {!(proposal.signature_status && SIGNATURE_STATUS_STYLES[proposal.signature_status]) && (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                            <StatusIcon className="w-3 h-3" />
                            {statusStyle.label}
                          </span>
                        )}
                        {proposal.signature_status && SIGNATURE_STATUS_STYLES[proposal.signature_status] && (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${SIGNATURE_STATUS_STYLES[proposal.signature_status].bg} ${SIGNATURE_STATUS_STYLES[proposal.signature_status].text}`}>
                            {(() => { const SigIcon = SIGNATURE_STATUS_STYLES[proposal.signature_status!].icon; return <SigIcon className="w-3 h-3" />; })()}
                            {SIGNATURE_STATUS_STYLES[proposal.signature_status].label}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {(() => {
                        const { value, isRange, minValue } = getProposalDisplayValue(proposal);
                        return isRange ? (
                          <span className="text-white font-medium">
                            {formatCurrency(minValue, proposal.currency)}
                            <span className="text-hud-cream-mute mx-1">–</span>
                            {formatCurrency(value, proposal.currency)}
                          </span>
                        ) : (
                          <span className="text-white font-medium">
                            {formatCurrency(value, proposal.currency)}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-hud-cream-soft">{formatDateNumeric(proposal.valid_until)}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 text-hud-cream-dim text-sm">
                        <Calendar className="w-4 h-4" />
                        {formatDateNumeric(proposal.created_at)}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="relative">
                        <button
                          onClick={() => setActionMenuId(actionMenuId === proposal.id ? null : proposal.id)}
                          className="p-2 hover:bg-hud-bg-elev rounded-lg transition-colors"
                        >
                          <MoreVertical className="w-4 h-4 text-hud-cream-dim" />
                        </button>

                        {actionMenuId === proposal.id && (
                          <AnchoredMenu className="w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50">
                            <button
                              onClick={() => navigate(`/proposals/${proposal.id}`)}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                            >
                              <Eye className="w-4 h-4" />
                              View Details
                            </button>
                            <button
                              onClick={() => handleExportPDF(proposal)}
                              disabled={exportingId === proposal.id}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors disabled:opacity-50"
                            >
                              {exportingId === proposal.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <FileDown className="w-4 h-4" />
                              )}
                              Export PDF
                            </button>
                            {canSend && proposal.status === 'draft' && (
                              <button
                                onClick={() => handleSendProposal(proposal)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                              >
                                <Send className="w-4 h-4" />
                                Send Proposal
                              </button>
                            )}
                            {proposal.status !== 'draft' && (
                              <button
                                onClick={() => copyPublicLink(proposal.public_token)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                              >
                                <Copy className="w-4 h-4" />
                                Copy Link
                              </button>
                            )}
                            {proposal.status !== 'draft' && (
                              <a
                                href={`/p/${proposal.public_token}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                              >
                                <ExternalLink className="w-4 h-4" />
                                Open Public View
                              </a>
                            )}
                            {canDelete && (
                              <button
                                onClick={() => handleDeleteProposal(proposal)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-bg-elev transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                                Delete
                              </button>
                            )}
                          </AnchoredMenu>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
            </div>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="px-6 py-4 border-t border-hud-bg-elev/50 flex items-center justify-between">
          <p className="text-sm text-hud-cream-dim">
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, totalCount)} of {totalCount} proposals
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft hover:bg-hud-bg-elev transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <span className="text-hud-cream-dim text-sm">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft hover:bg-hud-bg-elev transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {showCreateModal && (
        <CreateProposalModal
          preselectedContactId={preselectedContactId}
          preselectedOpportunityId={preselectedOpportunityId}
          onClose={() => {
            setShowCreateModal(false);
            setPreselectedContactId(undefined);
            setPreselectedOpportunityId(undefined);
          }}
          onCreated={() => {
            setShowCreateModal(false);
            setPreselectedContactId(undefined);
            setPreselectedOpportunityId(undefined);
            loadData();
          }}
        />
      )}
    </div>
  );
}
