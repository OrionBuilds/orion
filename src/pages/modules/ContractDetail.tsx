import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import {
  getContractById,
  deleteContract,
  archiveContract,
  unarchiveContract,
  updateContractSection,
  deleteContractSection,
  addContractComment,
  getContractComments,
  getContractActivities,
  getContractScopeIndex,
  updateContractScopeIndex,
  confirmContractScopeIndex,
  type ContractScopeIndex,
} from '../../services/contracts';
import {
  getContractSignatureRequest,
  getContractAuditEvents,
  voidContractSignatureRequest,
} from '../../services/contractSigning';
import { exportContractToPDF } from '../../services/contractPdfExport';
import { downloadSignedPdf } from '../../services/signedDocumentPdf';
import { getBrandKits } from '../../services/brandboard';
import { SendContractForSignatureModal } from '../../components/contracts/SendContractForSignatureModal';
import { ContractShareActions } from '../../components/contracts/ContractShareActions';
import { DocumentSectionsList } from '../../components/documents/DocumentSectionsList';
import { DocumentCommentsTab } from '../../components/documents/DocumentCommentsTab';
import { DocumentActivityFeed } from '../../components/documents/DocumentActivityFeed';
import { DocumentAuditTrail } from '../../components/documents/DocumentAuditTrail';
import { ScopeIndexTab } from '../../components/contracts/ScopeIndexTab';
import type {
  Contract,
  ContractComment,
  ContractActivity,
  ContractSignatureRequest,
  ContractAuditEvent,
} from '../../types';
import {
  ArrowLeft,
  FileText,
  FileDown,
  Send,
  CreditCard as Edit3,
  Trash2,
  Loader2,
  Calendar,
  DollarSign,
  Clock,
  CheckCircle2,
  XCircle,
  Eye,
  AlertCircle,
  MessageSquare,
  Activity,
  Sparkles,
  ExternalLink,
  Copy,
  MoreVertical,
  PenTool,
  Shield,
  Ban,
  RefreshCw,
  Scale,
  Archive,
  ArchiveRestore,
  MapPin,
} from 'lucide-react';
import { formatCurrencyOptionalCents, formatDateTimeShort } from '../../utils/formatters';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: typeof Clock; label: string }> = {
  draft: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-soft', icon: Clock, label: 'Draft' },
  pending_review: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', icon: Eye, label: 'Pending Review' },
  active: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: CheckCircle2, label: 'Active' },
  signed: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: PenTool, label: 'Signed' },
  declined: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', icon: XCircle, label: 'Declined' },
  expired: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', icon: AlertCircle, label: 'Expired' },
  voided: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', icon: Ban, label: 'Voided' },
};

const SIG_STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  not_sent: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-dim', label: 'Not Sent' },
  pending_signature: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', label: 'Pending Signature' },
  viewed: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', label: 'Viewed' },
  signed: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', label: 'Signed' },
  declined: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', label: 'Declined' },
  expired: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', label: 'Expired' },
  voided: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', label: 'Voided' },
};

const AUDIT_ICONS: Record<string, { icon: typeof Clock; color: string }> = {
  sent_for_signature: { icon: Send, color: 'text-hud-gold-soft' },
  viewed: { icon: Eye, color: 'text-hud-rust' },
  signed: { icon: PenTool, color: 'text-hud-emerald' },
  declined: { icon: XCircle, color: 'text-hud-plum' },
  voided: { icon: Ban, color: 'text-hud-cream-dim' },
  resent: { icon: RefreshCw, color: 'text-hud-gold-soft' },
};

const CONTRACT_TYPE_LABELS: Record<string, string> = {
  freelance_service: 'Freelance Service Agreement',
  retainer: 'Retainer Agreement',
  partnership: 'Partnership Agreement',
  nda: 'Non-Disclosure Agreement',
};

type TabType = 'content' | 'signature' | 'scope-index' | 'comments' | 'activity';

export function ContractDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  const { showToast } = useToast();

  const [contract, setContract] = useState<Contract | null>(null);
  const [comments, setComments] = useState<ContractComment[]>([]);
  const [activities, setActivities] = useState<ContractActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('content');
  const [newComment, setNewComment] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [sectionContent, setSectionContent] = useState('');
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [isExportingPDF, setIsExportingPDF] = useState(false);
  const [isDownloadingSigned, setIsDownloadingSigned] = useState(false);
  const [signatureRequest, setSignatureRequest] = useState<ContractSignatureRequest | null>(null);
  const [auditEvents, setAuditEvents] = useState<ContractAuditEvent[]>([]);
  const [isVoiding, setIsVoiding] = useState(false);
  const [scopeIndex, setScopeIndex] = useState<ContractScopeIndex | null>(null);
  const [isLoadingScopeIndex, setIsLoadingScopeIndex] = useState(false);
  const [isSavingScopeIndex, setIsSavingScopeIndex] = useState(false);

  const canEdit = hasPermission('contracts.edit');
  const canSend = hasPermission('contracts.send');
  const canDelete = hasPermission('contracts.delete');

  const loadContract = async () => {
    if (!id) return;
    try {
      setIsLoading(true);
      const [data, commentsData, activitiesData] = await Promise.all([
        getContractById(id),
        getContractComments(id),
        getContractActivities(id),
      ]);
      setContract(data);
      setComments(commentsData);
      setActivities(activitiesData);

      if (data) {
        const [sigReq, audit] = await Promise.all([
          getContractSignatureRequest(id),
          getContractAuditEvents(id),
        ]);
        setSignatureRequest(sigReq);
        setAuditEvents(audit);
      }
    } catch (err) {
      console.error('Failed to load contract:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadScopeIndex = async () => {
    if (!id) return;
    try {
      setIsLoadingScopeIndex(true);
      setScopeIndex(await getContractScopeIndex(id));
    } catch (err) {
      console.error('Failed to load scope index:', err);
    } finally {
      setIsLoadingScopeIndex(false);
    }
  };

  const handleScopeIndexSave = async (patch: Parameters<typeof updateContractScopeIndex>[1]) => {
    if (!scopeIndex) return;
    try {
      setIsSavingScopeIndex(true);
      setScopeIndex(await updateContractScopeIndex(scopeIndex.id, patch));
      showToast('success', 'Scope index updated');
    } catch (err) {
      console.error('Failed to update scope index:', err);
      showToast('error', 'Failed to update scope index');
    } finally {
      setIsSavingScopeIndex(false);
    }
  };

  const handleScopeIndexConfirm = async () => {
    if (!scopeIndex || !user) return;
    try {
      setIsSavingScopeIndex(true);
      setScopeIndex(await confirmContractScopeIndex(scopeIndex.id, user.id));
      showToast('success', 'Scope index confirmed');
    } catch (err) {
      console.error('Failed to confirm scope index:', err);
      showToast('error', 'Failed to confirm scope index');
    } finally {
      setIsSavingScopeIndex(false);
    }
  };

  useEffect(() => {
    loadContract();
  }, [id]);

  useEffect(() => {
    if (activeTab === 'scope-index' && !scopeIndex && !isLoadingScopeIndex) {
      loadScopeIndex();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="text-center py-16">
        <Scale className="w-12 h-12 mx-auto mb-4 text-hud-cream-mute" />
        <h2 className="text-xl font-semibold text-white mb-2">Contract Not Found</h2>
        <button onClick={() => navigate(-1)} className="text-hud-gold-soft hover:text-hud-gold-soft mt-2">
          Go Back
        </button>
      </div>
    );
  }

  const sigStatus = contract.signature_status || 'not_sent';
  const isFrozen = ['pending_signature', 'viewed', 'signed'].includes(sigStatus);
  const canRequestSignature = canSend && contract.status === 'draft' && !isFrozen;
  const statusStyle = STATUS_STYLES[contract.status] || STATUS_STYLES.draft;
  const StatusIcon = statusStyle.icon;
  const typeLabel = CONTRACT_TYPE_LABELS[contract.contract_type] || contract.contract_type;

  const handleSectionUpdate = async (sectionId: string, content: string) => {
    try {
      await updateContractSection(sectionId, contract.id, { content });
      loadContract();
      setEditingSection(null);
      showToast('success', 'Section updated');
    } catch (err) {
      console.error('Failed to update section:', err);
      showToast('error', 'Failed to update section');
    }
  };

  const handleDeleteSection = async (sectionId: string) => {
    if (!confirm('Delete this section?')) return;
    try {
      await deleteContractSection(sectionId, contract.id);
      loadContract();
      showToast('success', 'Section deleted');
    } catch (err) {
      console.error('Failed to delete section:', err);
      showToast('error', 'Failed to delete section');
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !user) return;
    try {
      setIsSubmittingComment(true);
      await addContractComment(user.organization_id, contract.id, user.id, newComment.trim());
      setNewComment('');
      const updated = await getContractComments(contract.id);
      setComments(updated);
    } catch (err) {
      console.error('Failed to add comment:', err);
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const handleDownloadSignedPDF = async () => {
    try {
      setIsDownloadingSigned(true);
      await downloadSignedPdf('contract', contract.id);
    } catch (err) {
      console.error('Signed PDF export failed:', err);
      showToast('error', err instanceof Error ? err.message : 'Could not build the signed PDF.');
    } finally {
      setIsDownloadingSigned(false);
    }
  };

  const handleExportPDF = async () => {
    try {
      setIsExportingPDF(true);
      let brandKit = null;
      try {
        const kits = await getBrandKits(user!.organization_id, { active: true });
        if (kits.length > 0) brandKit = kits[0];
      } catch { /* continue */ }
      await exportContractToPDF(contract, brandKit);
    } catch (err) {
      console.error('Export failed:', err);
      showToast('error', 'Export failed. Allow pop-ups and try again.');
    } finally {
      setIsExportingPDF(false);
    }
  };

  const copyPublicLink = () => {
    if (!contract.public_token) return;
    navigator.clipboard.writeText(`${window.location.origin}/c/${contract.public_token}`);
    showToast('success', 'Public link copied');
  };

  const handleArchive = async () => {
    try {
      if (contract.archived_at) {
        await unarchiveContract(contract.id);
        showToast('success', 'Contract unarchived');
      } else {
        await archiveContract(contract.id);
        showToast('success', 'Contract archived');
      }
      loadContract();
    } catch { showToast('error', 'Action failed'); }
  };

  const handleDelete = async () => {
    if (!confirm('Permanently delete this contract?')) return;
    try {
      await deleteContract(contract.id);
      showToast('success', 'Contract deleted');
      navigate(-1);
    } catch { showToast('error', 'Delete failed'); }
  };

  const handleVoid = async () => {
    if (!signatureRequest || !user) return;
    try {
      setIsVoiding(true);
      await voidContractSignatureRequest(signatureRequest.id, contract.id, user.organization_id, user.id);
      showToast('success', 'Signature request voided');
      loadContract();
    } catch { showToast('error', 'Void failed'); }
    finally { setIsVoiding(false); }
  };

  // handleResend was removed 2026-08-03. It rotated the signing token, copied the link to the
  // clipboard and toasted "Resent." -- while sending nothing. ContractShareActions replaces it
  // with actions that do what they say: resend the email, text the link, or mint a link to send
  // by hand. See services/contractSignatureShare.ts.

  const handleSendForSignature = () => setShowSignatureModal(true);

  const sections = [...(contract.sections || [])].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">{contract.title}</h1>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
              <StatusIcon className="w-3.5 h-3.5" />
              {statusStyle.label}
            </span>
            {isFrozen && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-hud-rust/20 text-hud-rust/40">
                <Shield className="w-3 h-3" />
                Locked
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 mt-1 text-sm text-hud-cream-dim">
            <span>{typeLabel}</span>
            {contract.contact && (
              <span>
                {contract.contact.first_name} {contract.contact.last_name}
                {contract.contact.company && ` (${contract.contact.company})`}
              </span>
            )}
            {contract.total_value > 0 && (
              <span className="font-medium text-hud-emerald">
                {formatCurrencyOptionalCents(contract.total_value, contract.currency)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {hasPermission('contracts.create') && contract.status === 'draft' && (
            <Link
              to={`/contracts/${contract.id}/build`}
              className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-hud-gold-soft rounded-lg transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              AI Builder
            </Link>
          )}
          {canRequestSignature && (
            <button onClick={handleSendForSignature} className="flex items-center gap-2 px-4 py-2 bg-hud-teal hover:bg-hud-teal text-hud-bg-deep rounded-lg transition-colors">
              <PenTool className="w-4 h-4" />
              Send for Signature
            </button>
          )}
          {contract.public_token && (
            <>
              <button onClick={copyPublicLink} className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors">
                <Copy className="w-4 h-4" />
                Copy Link
              </button>
              <a href={`/c/${contract.public_token}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors">
                <ExternalLink className="w-4 h-4" />
                Preview
              </a>
            </>
          )}
          {/* Two different documents, deliberately labelled apart. "Export current" re-renders
              today's contract data; the signed one reproduces the immutable snapshot taken when it
              was sent for signature. Before this they would both have read "Export PDF", and
              reaching for the wrong one in a payment dispute means handing a merchant a document
              that may not match what the client actually signed. */}
          {contract.frozen_html_snapshot && (sigStatus === 'signed' || contract.status === 'signed' || !!contract.signed_at) && (
            <button
              onClick={handleDownloadSignedPDF}
              disabled={isDownloadingSigned}
              title="The document exactly as it was signed, with the signature and audit record attached"
              className="flex items-center gap-2 px-4 py-2 bg-hud-emerald-dim/20 text-hud-emerald/40 border border-hud-emerald/30 hover:bg-hud-emerald-dim/30 rounded-lg transition-colors disabled:opacity-50"
            >
              {isDownloadingSigned ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              {isDownloadingSigned ? 'Building PDF…' : 'Download Signed PDF'}
            </button>
          )}
          <button onClick={handleExportPDF} disabled={isExportingPDF} title="Re-renders the contract as it stands today — not the signed copy" className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors disabled:opacity-50">
            {isExportingPDF ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Export current
          </button>
          <div className="relative">
            <button onClick={() => setShowActionMenu(!showActionMenu)} className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors">
              <MoreVertical className="w-5 h-5 text-hud-cream-dim" />
            </button>
            {showActionMenu && (
              <AnchoredMenu className="w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50">
                {canEdit && (
                  <button onClick={handleArchive} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors">
                    {contract.archived_at ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                    {contract.archived_at ? 'Unarchive' : 'Archive'}
                  </button>
                )}
                {contract.source_proposal && (
                  <Link to={`/proposals/${contract.proposal_id}`} onClick={() => setShowActionMenu(false)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors">
                    <FileText className="w-4 h-4" />
                    View Source Proposal
                  </Link>
                )}
                {canDelete && (
                  <button onClick={handleDelete} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-bg-elev transition-colors">
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                )}
              </AnchoredMenu>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
          <div className="flex items-center gap-2 text-xs text-hud-cream-mute mb-1">
            <Calendar className="w-3.5 h-3.5" />
            Effective Date
          </div>
          <p className="text-sm text-white">{contract.effective_date ? new Date(contract.effective_date).toLocaleDateString() : 'Upon signing'}</p>
        </div>
        <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
          <div className="flex items-center gap-2 text-xs text-hud-cream-mute mb-1">
            <MapPin className="w-3.5 h-3.5" />
            Governing Law
          </div>
          <p className="text-sm text-white">{contract.governing_law_state || 'Not specified'}</p>
        </div>
        <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
          <div className="flex items-center gap-2 text-xs text-hud-cream-mute mb-1">
            <DollarSign className="w-3.5 h-3.5" />
            Contract Value
          </div>
          <p className="text-sm text-white font-medium">{formatCurrencyOptionalCents(contract.total_value || 0, contract.currency)}</p>
        </div>
      </div>

      {contract.party_a_name || contract.party_b_name ? (
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
            <h3 className="text-xs font-medium text-hud-gold-soft uppercase tracking-wider mb-2">Party A (Service Provider)</h3>
            <p className="text-sm text-white font-medium">{contract.party_a_name || 'Not set'}</p>
            {contract.party_a_email && <p className="text-xs text-hud-cream-dim mt-1">{contract.party_a_email}</p>}
          </div>
          <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
            <h3 className="text-xs font-medium text-hud-gold-soft uppercase tracking-wider mb-2">Party B (Client)</h3>
            <p className="text-sm text-white font-medium">{contract.party_b_name || contract.contact ? `${contract.contact?.first_name} ${contract.contact?.last_name}` : 'Not set'}</p>
            {(contract.party_b_email || contract.contact?.email) && (
              <p className="text-xs text-hud-cream-dim mt-1">{contract.party_b_email || contract.contact?.email}</p>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-1 mb-6">
        {(['content', 'signature', 'scope-index', 'comments', 'activity'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab ? 'bg-hud-bg-card text-white' : 'text-hud-cream-dim hover:text-white hover:bg-hud-bg-card/50'
            }`}
          >
            {tab === 'content' && <FileText className="w-4 h-4 inline mr-2" />}
            {tab === 'signature' && <PenTool className="w-4 h-4 inline mr-2" />}
            {tab === 'scope-index' && <Scale className="w-4 h-4 inline mr-2" />}
            {tab === 'comments' && <MessageSquare className="w-4 h-4 inline mr-2" />}
            {tab === 'activity' && <Activity className="w-4 h-4 inline mr-2" />}
            {tab === 'scope-index' ? 'Scope Index' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === 'comments' && comments.length > 0 && (
              <span className="ml-2 px-1.5 py-0.5 bg-hud-gold/20 text-hud-gold-soft rounded text-xs">{comments.length}</span>
            )}
            {tab === 'signature' && sigStatus === 'signed' && (
              <span className="ml-2 px-1.5 py-0.5 bg-hud-emerald/20 text-hud-emerald/40 rounded text-xs">Signed</span>
            )}
            {tab === 'scope-index' && scopeIndex?.status === 'extracted' && (
              <span className="ml-2 px-1.5 py-0.5 bg-hud-rust/20 text-hud-rust/40 rounded text-xs">Needs review</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'content' && (
        <div className="space-y-4">
          <DocumentSectionsList
            sections={sections}
            editingSectionId={editingSection}
            sectionContent={sectionContent}
            onSectionContentChange={setSectionContent}
            onEditClick={(section) => { setEditingSection(section.id); setSectionContent(section.content); }}
            onCancelEdit={() => setEditingSection(null)}
            onSave={(sectionId) => handleSectionUpdate(sectionId, sectionContent)}
            onDelete={handleDeleteSection}
            canEdit={canEdit && !isFrozen}
            renderContent={(content) => sanitizeHtml(content)}
            emptyState={
              <div className="text-center py-12 text-hud-cream-dim">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p>No contract sections yet</p>
                <p className="text-sm mt-1">
                  Use the AI builder to draft them from client meetings and your terms
                </p>
                {hasPermission('contracts.create') && contract.status === 'draft' && (
                  <Link
                    to={`/contracts/${contract.id}/build`}
                    className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    <Sparkles className="w-4 h-4" />
                    Open AI Builder
                  </Link>
                )}
              </div>
            }
          />
        </div>
      )}

      {activeTab === 'signature' && (
        <div className="space-y-6">
          {!signatureRequest && sigStatus === 'not_sent' ? (
            <div className="text-center py-12 text-hud-cream-dim">
              <PenTool className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>No signature request has been sent for this contract</p>
              {canRequestSignature && (
                <button onClick={handleSendForSignature} className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-hud-teal hover:bg-hud-teal text-hud-bg-deep rounded-lg transition-colors">
                  <PenTool className="w-4 h-4" />
                  Send for Signature
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-white flex items-center gap-2">
                    <PenTool className="w-5 h-5 text-hud-gold-soft" />
                    Signature Status
                  </h3>
                  {SIG_STATUS_STYLES[sigStatus] && (
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${SIG_STATUS_STYLES[sigStatus].bg} ${SIG_STATUS_STYLES[sigStatus].text}`}>
                      {SIG_STATUS_STYLES[sigStatus].label}
                    </span>
                  )}
                </div>
                {signatureRequest && (
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-hud-cream-dim">Signer:</span>
                      <p className="text-white">{signatureRequest.signer_name}</p>
                    </div>
                    <div>
                      <span className="text-hud-cream-dim">Email:</span>
                      <p className="text-white">{signatureRequest.signer_email}</p>
                    </div>
                    <div>
                      <span className="text-hud-cream-dim">Expires:</span>
                      <p className="text-white">{formatDateTimeShort(signatureRequest.expires_at, { hour: 'numeric', fallback: '' })}</p>
                    </div>
                    {signatureRequest.viewed_at && (
                      <div>
                        <span className="text-hud-cream-dim">Viewed:</span>
                        <p className="text-white">{formatDateTimeShort(signatureRequest.viewed_at, { hour: 'numeric', fallback: '' })}</p>
                      </div>
                    )}
                    {signatureRequest.signed_at && (
                      <div>
                        <span className="text-hud-cream-dim">Signed:</span>
                        <p className="text-hud-emerald">{formatDateTimeShort(signatureRequest.signed_at, { hour: 'numeric', fallback: '' })}</p>
                      </div>
                    )}
                    {signatureRequest.declined_at && (
                      <div>
                        <span className="text-hud-cream-dim">Declined:</span>
                        <p className="text-hud-plum">{formatDateTimeShort(signatureRequest.declined_at, { hour: 'numeric', fallback: '' })}</p>
                      </div>
                    )}
                    {signatureRequest.decline_reason && (
                      <div className="col-span-2">
                        <span className="text-hud-cream-dim">Reason:</span>
                        <p className="text-hud-plum/40">{signatureRequest.decline_reason}</p>
                      </div>
                    )}
                  </div>
                )}
                {signatureRequest && ['pending', 'viewed'].includes(signatureRequest.status) && canSend && (
                  <div className="flex items-center gap-2 pt-4 mt-4 border-t border-hud-bg-elev">
                    <button onClick={handleVoid} disabled={isVoiding} className="flex items-center gap-2 px-4 py-2 bg-hud-plum hover:bg-hud-plum text-white rounded-lg transition-colors disabled:opacity-50">
                      {isVoiding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
                      Void
                    </button>
                  </div>
                )}
              </div>

              {signatureRequest && ['pending', 'viewed'].includes(signatureRequest.status) && canSend && user && (
                <ContractShareActions
                  ctx={{
                    contract: {
                      id: contract.id,
                      org_id: contract.org_id,
                      title: contract.title,
                      total_value: contract.total_value,
                      currency: contract.currency,
                      contact_id: contract.contact_id,
                    },
                    request: {
                      id: signatureRequest.id,
                      signer_name: signatureRequest.signer_name,
                      signer_email: signatureRequest.signer_email,
                      expires_at: signatureRequest.expires_at,
                    },
                    actorUserId: user.id,
                    companyName: user.organization?.name || 'Our Company',
                  }}
                  defaultPhone={contract.contact?.phone || ''}
                  onChanged={loadContract}
                  showToast={showToast}
                />
              )}

              <DocumentAuditTrail
                events={auditEvents}
                iconMap={AUDIT_ICONS}
              />
            </>
          )}
        </div>
      )}

      {activeTab === 'scope-index' && (
        <ScopeIndexTab
          scopeIndex={scopeIndex}
          isLoading={isLoadingScopeIndex}
          isSaving={isSavingScopeIndex}
          onSave={handleScopeIndexSave}
          onConfirm={handleScopeIndexConfirm}
        />
      )}

      {activeTab === 'comments' && (
        <DocumentCommentsTab
          comments={comments}
          newComment={newComment}
          onNewCommentChange={setNewComment}
          onSubmit={handleAddComment}
          isSubmitting={isSubmittingComment}
        />
      )}

      {activeTab === 'activity' && (
        <DocumentActivityFeed
          activities={activities}
          renderIcon={(type) => {
            // BUG FIX (flagged): ContractActivityType has 'edited'/'comment_added', not
            // 'updated'/'commented' — these two branches could never match, so edited and
            // comment activities always fell through to the generic icon. Now they render
            // their intended icons. Fallback list updated to match so no double icon.
            switch (type) {
              case 'created': return <Scale className="w-4 h-4 text-hud-emerald" />;
              case 'ai_generated': return <Sparkles className="w-4 h-4 text-hud-gold-soft" />;
              case 'edited': return <Edit3 className="w-4 h-4 text-hud-cream-dim" />;
              case 'status_changed': return <Activity className="w-4 h-4 text-hud-cream-dim" />;
              case 'comment_added': return <MessageSquare className="w-4 h-4 text-hud-cream-dim" />;
              case 'sent': return <Send className="w-4 h-4 text-hud-gold-soft" />;
              default: return <Activity className="w-4 h-4 text-hud-cream-mute" />;
            }
          }}
        />
      )}

      {showSignatureModal && contract && (
        <SendContractForSignatureModal
          contract={contract}
          onClose={() => setShowSignatureModal(false)}
          onSent={() => {
            setShowSignatureModal(false);
            loadContract();
          }}
        />
      )}
    </div>
  );
}
