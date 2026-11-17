import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInTabbedModule } from '../../hooks/useInTabbedModule';
import { useAuth } from '../../contexts/AuthContext';
import {
  getContracts,
  getContractStats,
  deleteContract,
  archiveContract,
  unarchiveContract,
} from '../../services/contracts';
import { CreateContractModal } from '../../components/contracts/CreateContractModal';
import type { Contract, ContractStatus, ContractSignatureStatus } from '../../types';
import type { ContractStats, ContractListFilters } from '../../services/contracts';
import { Ligature as FileSignature, Plus, Search, Filter, MoreVertical, Eye, Trash2, Loader2, CheckCircle2, Clock, XCircle, DollarSign, Calendar, User, ChevronDown, ExternalLink, Copy, PenTool, Ban, Send, Archive, ArchiveRestore, FileText } from 'lucide-react';
import { formatCurrency, formatDateNumeric } from '../../utils/formatters';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';
import { formerContactLabel } from '../../utils/formerContact';

const STATUS_STYLES: Record<ContractStatus, { bg: string; text: string; icon: typeof Clock; label: string }> = {
  draft: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-soft', icon: Clock, label: 'Draft' },
  sent: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', icon: Send, label: 'Sent' },
  viewed: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', icon: Eye, label: 'Viewed' },
  signed: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: CheckCircle2, label: 'Signed' },
  declined: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', icon: XCircle, label: 'Declined' },
  expired: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', icon: Clock, label: 'Expired' },
  voided: { bg: 'bg-hud-cream-mute/30', text: 'text-hud-cream-dim', icon: Ban, label: 'Voided' },
};

const SIGNATURE_STYLES: Record<string, { bg: string; text: string; icon: typeof PenTool; label: string }> = {
  pending_signature: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', icon: PenTool, label: 'Awaiting Signature' },
  viewed: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', icon: Eye, label: 'Viewed by Signer' },
  signed: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: PenTool, label: 'Signed' },
  declined: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', icon: Ban, label: 'Declined' },
  voided: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-dim', icon: Ban, label: 'Voided' },
};

const CONTRACT_TYPE_LABELS: Record<string, string> = {
  freelance_service: 'Freelance Service',
  retainer: 'Retainer',
  partnership: 'Partnership',
  nda: 'NDA',
};

export function Contracts() {
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  const canCreate = hasPermission('contracts.create');
  const inTabbedModule = useInTabbedModule();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [stats, setStats] = useState<ContractStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ContractStatus | 'all'>('all');
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const pageSize = 25;

  const canView = hasPermission('contracts.view');
  const canDelete = hasPermission('contracts.delete');

  useEffect(() => {
    if (canView) loadData();
  }, [user, canView, page, statusFilter, searchQuery]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const filters: ContractListFilters = {};
      if (statusFilter !== 'all') filters.status = [statusFilter];
      if (searchQuery) filters.search = searchQuery;

      const [listResult, statsData] = await Promise.all([
        getContracts(filters, page, pageSize),
        getContractStats(),
      ]);

      setContracts(listResult.data);
      setTotalCount(listResult.total);
      setStats(statsData);
    } catch (err) {
      console.error('Failed to load contracts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (contract: Contract) => {
    if (!confirm('Are you sure you want to delete this contract? This cannot be undone.')) return;
    try {
      await deleteContract(contract.id);
      loadData();
    } catch (err) {
      console.error('Failed to delete contract:', err);
    }
    setActionMenuId(null);
  };

  const handleArchive = async (contract: Contract) => {
    try {
      if (contract.archived_at) {
        await unarchiveContract(contract.id);
      } else {
        await archiveContract(contract.id);
      }
      loadData();
    } catch (err) {
      console.error('Failed to archive/unarchive contract:', err);
    }
    setActionMenuId(null);
  };

  const copyPublicLink = (token: string | null) => {
    if (!token) return;
    const url = `${window.location.origin}/c/${token}`;
    navigator.clipboard.writeText(url);
  };

  const getContactName = (contract: Contract) => {
    if (contract.party_b_name) return contract.party_b_name;
    const c = contract.contact as { first_name?: string; last_name?: string; company?: string } | null;
    if (!c) return formerContactLabel(contract.former_contact) ?? 'Unknown';
    return c.company || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unknown';
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  if (!canView) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-hud-cream-dim">You don't have permission to view contracts.</p>
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
                <FileSignature className="w-7 h-7 text-hud-gold-soft" />
                Contracts
              </h1>
              <p className="text-hud-cream-dim mt-1">Create contracts from client meetings, or from a proposal</p>
            </div>
          )}
          {canCreate && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Contract
            </button>
          )}
        </div>
        )}

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-cream-dim text-sm mb-1">
                <FileText className="w-4 h-4" />
                Total
              </div>
              <p className="text-2xl font-semibold text-white">{stats.total}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-cream-dim text-sm mb-1">
                <Clock className="w-4 h-4" />
                Drafts
              </div>
              <p className="text-2xl font-semibold text-hud-cream-soft">{stats.draft}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-gold-soft text-sm mb-1">
                <Send className="w-4 h-4" />
                Sent
              </div>
              <p className="text-2xl font-semibold text-hud-gold-soft">{stats.sent}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-emerald text-sm mb-1">
                <CheckCircle2 className="w-4 h-4" />
                Signed
              </div>
              <p className="text-2xl font-semibold text-hud-emerald/40">{stats.signed}</p>
            </div>
            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev/50">
              <div className="flex items-center gap-2 text-hud-cream-dim text-sm mb-1">
                <DollarSign className="w-4 h-4" />
                Total Value
              </div>
              <p className="text-2xl font-semibold text-white">{formatCurrency(stats.totalValue)}</p>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 py-4 flex items-center gap-4 border-b border-hud-bg-elev/50">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
          <input
            type="text"
            placeholder="Search contracts..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
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
            onChange={(e) => { setStatusFilter(e.target.value as ContractStatus | 'all'); setPage(1); }}
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="viewed">Viewed</option>
            <option value="signed">Signed</option>
            <option value="declined">Declined</option>
            <option value="expired">Expired</option>
            <option value="voided">Voided</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
          </div>
        ) : contracts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-hud-cream-dim">
            <FileSignature className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-lg font-medium text-hud-cream-soft mb-1">No contracts found</p>
            <p className="text-sm">Create one from client meetings, or convert an existing proposal</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-hud-bg-card/95 sticky top-0 z-10 backdrop-blur-sm">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Contract</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Client</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Type</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Value</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Effective</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Created</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-bg-elev/50">
              {contracts.map((contract) => {
                const statusStyle = STATUS_STYLES[contract.status];
                const StatusIcon = statusStyle.icon;
                const sigStatus = contract.signature_status as ContractSignatureStatus;
                const sigStyle = sigStatus && sigStatus !== 'not_sent' ? SIGNATURE_STYLES[sigStatus] : null;

                return (
                  <tr
                    key={contract.id}
                    onClick={() => navigate(`/contracts/${contract.id}`)}
                    className="hover:bg-hud-bg-card/30 cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-hud-gold/20 flex items-center justify-center flex-shrink-0">
                          <FileSignature className="w-5 h-5 text-hud-gold-soft" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-white font-medium truncate">{contract.title}</p>
                          {contract.source_proposal && (
                            <span className="text-xs text-hud-cream-mute truncate block">
                              From: {(contract.source_proposal as { title?: string }).title}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-hud-cream-dim flex-shrink-0" />
                        <span className="text-hud-cream-soft truncate">{getContactName(contract)}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-hud-cream-soft text-sm">
                        {CONTRACT_TYPE_LABELS[contract.contract_type] || contract.contract_type}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        {!sigStyle && (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                            <StatusIcon className="w-3 h-3" />
                            {statusStyle.label}
                          </span>
                        )}
                        {sigStyle && (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${sigStyle.bg} ${sigStyle.text}`}>
                            {(() => { const SigIcon = sigStyle.icon; return <SigIcon className="w-3 h-3" />; })()}
                            {sigStyle.label}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-white font-medium">
                        {formatCurrency(contract.total_value, contract.currency)}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-hud-cream-soft">{formatDateNumeric(contract.effective_date)}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 text-hud-cream-dim text-sm">
                        <Calendar className="w-4 h-4" />
                        {formatDateNumeric(contract.created_at)}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="relative">
                        <button
                          onClick={() => setActionMenuId(actionMenuId === contract.id ? null : contract.id)}
                          className="p-2 hover:bg-hud-bg-elev rounded-lg transition-colors"
                        >
                          <MoreVertical className="w-4 h-4 text-hud-cream-dim" />
                        </button>

                        {actionMenuId === contract.id && (
                          <AnchoredMenu className="w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50">
                            <button
                              onClick={() => navigate(`/contracts/${contract.id}`)}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors rounded-t-lg"
                            >
                              <Eye className="w-4 h-4" />
                              View Details
                            </button>
                            {contract.public_token && (
                              <>
                                <button
                                  onClick={() => copyPublicLink(contract.public_token)}
                                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                                >
                                  <Copy className="w-4 h-4" />
                                  Copy Link
                                </button>
                                <a
                                  href={`/c/${contract.public_token}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                                >
                                  <ExternalLink className="w-4 h-4" />
                                  Public View
                                </a>
                              </>
                            )}
                            <button
                              onClick={() => handleArchive(contract)}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                            >
                              {contract.archived_at ? (
                                <>
                                  <ArchiveRestore className="w-4 h-4" />
                                  Unarchive
                                </>
                              ) : (
                                <>
                                  <Archive className="w-4 h-4" />
                                  Archive
                                </>
                              )}
                            </button>
                            {canDelete && (
                              <button
                                onClick={() => handleDelete(contract)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-bg-elev transition-colors rounded-b-lg"
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
        )}
      </div>

      {totalPages > 1 && (
        <div className="px-6 py-4 border-t border-hud-bg-elev/50 flex items-center justify-between">
          <p className="text-sm text-hud-cream-dim">
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, totalCount)} of {totalCount} contracts
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
        <CreateContractModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
