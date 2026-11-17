import { useState, useEffect } from 'react';
import { ProposalReviewError } from '../../../supabase/functions/_shared/proposal-review';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ReferencesPanel } from '../../components/shared/ReferencesPanel';
import { usePaymentsAccess } from '../../hooks/usePaymentsAccess';
import { SendForSignatureModal } from '../../components/proposals/SendForSignatureModal';
import { ConvertToInvoiceModal } from '../../components/proposals/ConvertToInvoiceModal';
import { ConvertToContractModal } from '../../components/proposals/ConvertToContractModal';
import { PricingTab } from '../../components/proposals/PricingTab';
import { DocumentLoadingState, DocumentNotFoundState } from '../../components/documents/DocumentEmptyStates';
import { DocumentSectionsList } from '../../components/documents/DocumentSectionsList';
import { DocumentCommentsTab } from '../../components/documents/DocumentCommentsTab';
import { DocumentActivityFeed } from '../../components/documents/DocumentActivityFeed';
import { DocumentAuditTrail } from '../../components/documents/DocumentAuditTrail';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import { downloadSignedPdf } from '../../services/signedDocumentPdf';
import {
  getProposalById,
  updateProposal,
  deleteProposal,
  duplicateProposal,
  archiveProposal,
  unarchiveProposal,
  getProposalComments,
  addProposalComment,
  getProposalActivities,
  updateProposalSection,
  deleteProposalSection,
  reorderProposalSections,
  addProposalLineItem,
  updateProposalLineItem,
  deleteProposalLineItem,
  recalculateAndUpdateProposalTotal,
} from '../../services/proposals';
import {
  getSignatureRequestByProposal,
  getAuditEvents,
  voidSignatureRequest,
  resendSignatureRequest,
} from '../../services/proposalSigning';
import { useToast } from '../../contexts/ToastContext';
import {
  sendSignatureRequestEmail,
  updateSignatureRequestSendStatus,
} from '../../services/proposalSignatureEmail';
import type { Proposal, ProposalComment, ProposalActivity, ProposalSection, ProposalLineItem, ProposalSignatureRequest, ProposalAuditEvent } from '../../types';
import { ArrowLeft, FileText, FileDown, Send, CreditCard as Edit3, Trash2, Loader2, User, Calendar, DollarSign, Clock, CheckCircle2, XCircle, Eye, AlertCircle, MessageSquare, Activity, Plus, GripVertical, Sparkles, ExternalLink, Copy, MoreVertical, Video, Archive, ArchiveRestore, Copy as CopyIcon, PenTool, Shield, Ban, RefreshCw, Mail, Scale } from 'lucide-react';
import { exportProposalToPDF } from '../../services/proposalPdfExport';
import { getBrandKits } from '../../services/brandboard';
import { sanitizeProposalContent } from '../../utils/proposalContentSanitizer';
import { formatCurrency, formatDateNumeric, formatDateTimeNumeric } from '../../utils/formatters';
import { logError } from '../../lib/errors';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';
import { brandName, DEFAULT_BRAND } from '../../lib/brands';

const FALLBACK_LOGO = '/assets/logo/orion-os-mark.png';

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: typeof Clock; label: string }> = {
  draft: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-soft', icon: Clock, label: 'Draft' },
  sent: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', icon: Send, label: 'Sent' },
  viewed: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', icon: Eye, label: 'Viewed' },
  accepted: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: CheckCircle2, label: 'Accepted' },
  rejected: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', icon: XCircle, label: 'Rejected' },
  expired: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', icon: AlertCircle, label: 'Expired' },
  signed: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', icon: PenTool, label: 'Signed' },
  declined: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', icon: Ban, label: 'Declined' },
  voided: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', icon: Ban, label: 'Voided' },
};

const SIGNATURE_STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  not_sent: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-dim', label: 'Not Sent' },
  pending_signature: { bg: 'bg-hud-rust/20', text: 'text-hud-rust/40', label: 'Pending Signature' },
  viewed: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', label: 'Viewed by Signer' },
  signed: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', label: 'Signed' },
  declined: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', label: 'Declined' },
  expired: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', label: 'Expired' },
  voided: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', label: 'Voided' },
};

const AUDIT_EVENT_ICONS: Record<string, { icon: typeof Clock; color: string }> = {
  sent_for_signature: { icon: Send, color: 'text-hud-gold-soft' },
  viewed: { icon: Eye, color: 'text-hud-rust' },
  signed: { icon: PenTool, color: 'text-hud-emerald' },
  declined: { icon: XCircle, color: 'text-hud-plum' },
  voided: { icon: Ban, color: 'text-hud-cream-dim' },
  resent: { icon: RefreshCw, color: 'text-hud-gold-soft' },
  reminder_sent: { icon: Mail, color: 'text-hud-gold-soft' },
  signed_document_generated: { icon: FileDown, color: 'text-hud-emerald' },
  proposal_signature_send_failed: { icon: AlertCircle, color: 'text-hud-plum' },
};

type TabType = 'content' | 'pricing' | 'comments' | 'activity' | 'signature';

export function ProposalDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, hasPermission, isFeatureEnabled } = useAuth();
  const canAccessPayments = usePaymentsAccess();
  const { showToast } = useToast();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [comments, setComments] = useState<ProposalComment[]>([]);
  const [activities, setActivities] = useState<ProposalActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('content');
  const [newComment, setNewComment] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [sectionContent, setSectionContent] = useState('');
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [showContractModal, setShowContractModal] = useState(false);
  const [isExportingPDF, setIsExportingPDF] = useState(false);
  const [signatureRequest, setSignatureRequest] = useState<ProposalSignatureRequest | null>(null);
  const [auditEvents, setAuditEvents] = useState<ProposalAuditEvent[]>([]);
  const [isVoiding, setIsVoiding] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isDownloadingSigned, setIsDownloadingSigned] = useState(false);

  const canEdit = hasPermission('proposals.edit');
  const canSend = hasPermission('proposals.send');
  const canDelete = hasPermission('proposals.delete');

  useEffect(() => {
    if (id) {
      loadProposal();
    }
  }, [id]);

  const loadProposal = async () => {
    try {
      setIsLoading(true);
      const data = await getProposalById(id!);
      setProposal(data);

      if (data) {
        const [commentsData, activitiesData, sigReq, auditData] = await Promise.all([
          getProposalComments(id!),
          getProposalActivities(id!),
          getSignatureRequestByProposal(id!),
          getAuditEvents(id!),
        ]);
        setComments(commentsData);
        setActivities(activitiesData);
        setSignatureRequest(sigReq);
        setAuditEvents(auditData);
      }
    } catch (err) {
      console.error('Failed to load proposal:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportPDF = async () => {
    if (!proposal) return;
    try {
      setIsExportingPDF(true);
      let brandKit = null;
      try {
        const kits = await getBrandKits(proposal.org_id, { active: true });
        if (kits.length > 0) brandKit = kits[0];
      } catch (err) {
        logError('ProposalDetail.handleExportPDF', err);
      }
      await exportProposalToPDF(proposal, brandKit);
    } catch (err) {
      console.error('Failed to export PDF:', err);
      alert('Failed to open print window. Please allow popups for this site.');
    } finally {
      setIsExportingPDF(false);
    }
  };

  const handleSignatureComplete = () => {
    setShowSignatureModal(false);
    loadProposal();
  };

  const handleSendForSignature = () => {
    if (!proposal?.contact?.email) {
      alert('This proposal must have a contact with an email address before requesting a signature.');
      return;
    }
    if (!proposal.sections?.length) {
      alert('Add content sections before requesting a signature.');
      return;
    }
    setShowSignatureModal(true);
  };

  const handleVoidSignature = async () => {
    if (!proposal || !signatureRequest || !user) return;
    if (!confirm('Void this signature request? The signer will no longer be able to sign.')) return;
    try {
      setIsVoiding(true);
      await voidSignatureRequest(signatureRequest.id, proposal.id, proposal.org_id, user.id);
      loadProposal();
    } catch (err) {
      console.error('Failed to void:', err);
    } finally {
      setIsVoiding(false);
    }
  };

  const handleResendSignature = async () => {
    if (!proposal || !signatureRequest || !user) return;
    try {
      setIsResending(true);
      // A resend is a send: it does not bypass the review gate. resendSignatureRequest is the authoritative
      // check — it re-reads the sections and throws ProposalReviewError on any flag not already acknowledged.
      const { signingUrl } = await resendSignatureRequest(
        signatureRequest.id,
        proposal.id,
        proposal.org_id,
        user.id
      );

      const companyName = user.organization?.name || 'Our Company';
      const expiresAt = signatureRequest.expires_at;

      const emailResult = await sendSignatureRequestEmail({
        proposalTitle: proposal.title,
        totalValue: proposal.total_value > 0
          ? formatCurrency(proposal.total_value, proposal.currency)
          : undefined,
        signerName: signatureRequest.signer_name,
        signerEmail: signatureRequest.signer_email,
        signingUrl,
        expiresAt,
        orgId: proposal.org_id,
        companyName,
      });

      if (emailResult.success) {
        await updateSignatureRequestSendStatus(signatureRequest.id, 'sent', emailResult.messageId);
        showToast('success', 'Signature request resent successfully');
      } else {
        await updateSignatureRequestSendStatus(signatureRequest.id, 'failed', undefined, emailResult.error);
        showToast('warning', emailResult.error || 'Failed to send signature request');
      }

      loadProposal();
    } catch (err) {
      if (err instanceof ProposalReviewError) {
        showToast('warning', `${err.flags.length} review flag(s) are unresolved (pricing, scope or totals). Resolve them, or use Send for Signature to acknowledge them.`);
      } else {
        console.error('Failed to resend:', err);
        showToast('warning', 'Failed to resend signature request');
      }
    } finally {
      setIsResending(false);
    }
  };

  const handleDeleteProposal = async () => {
    if (!proposal || !confirm('Are you sure you want to delete this proposal?')) return;
    try {
      await deleteProposal(proposal.id);
      navigate('/proposals');
    } catch (err) {
      console.error('Failed to delete proposal:', err);
    }
  };

  const handleDuplicateProposal = async () => {
    if (!proposal || !user) return;
    try {
      const duplicated = await duplicateProposal(proposal.id, user.id);
      navigate(`/proposals/${duplicated.id}`);
    } catch (err) {
      console.error('Failed to duplicate proposal:', err);
    }
  };

  const handleArchiveProposal = async () => {
    if (!proposal || !user) return;
    try {
      await archiveProposal(proposal.id, user.id);
      loadProposal();
    } catch (err) {
      console.error('Failed to archive proposal:', err);
    }
  };

  const handleUnarchiveProposal = async () => {
    if (!proposal || !user) return;
    try {
      await unarchiveProposal(proposal.id, user.id);
      loadProposal();
    } catch (err) {
      console.error('Failed to unarchive proposal:', err);
    }
  };

  const handleAddComment = async () => {
    if (!proposal || !user || !newComment.trim()) return;
    try {
      setIsSubmittingComment(true);
      await addProposalComment({
        org_id: proposal.org_id,
        proposal_id: proposal.id,
        user_id: user.id,
        content: newComment.trim(),
      });
      setNewComment('');
      const updatedComments = await getProposalComments(proposal.id);
      setComments(updatedComments);
    } catch (err) {
      console.error('Failed to add comment:', err);
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const handleSectionUpdate = async (sectionId: string, content: string) => {
    try {
      await updateProposalSection(sectionId, { content });
      loadProposal();
      setEditingSection(null);
    } catch (err) {
      console.error('Failed to update section:', err);
    }
  };

  const handleDeleteSection = async (sectionId: string) => {
    if (!confirm('Delete this section?')) return;
    try {
      await deleteProposalSection(sectionId);
      loadProposal();
    } catch (err) {
      console.error('Failed to delete section:', err);
    }
  };

  const copyPublicLink = () => {
    if (!proposal) return;
    const url = `${window.location.origin}/p/${proposal.public_token}`;
    navigator.clipboard.writeText(url);
  };

  if (isLoading) {
    return <DocumentLoadingState />;
  }

  if (!proposal) {
    return (
      <DocumentNotFoundState
        icon={FileText}
        label="Proposal not found"
        backHref="/proposals"
        backLabel="Back to Proposals"
      />
    );
  }

  const statusStyle = STATUS_STYLES[proposal.status] || STATUS_STYLES.draft;
  const StatusIcon = statusStyle.icon;
  const sigStatus = proposal.signature_status;
  const sigStyle = sigStatus ? SIGNATURE_STATUS_STYLES[sigStatus] : null;
  const isFrozenForSigning = ['pending_signature', 'viewed', 'signed'].includes(sigStatus || '');
  const canRequestSignature = canSend && ['draft', 'sent', 'viewed', 'accepted'].includes(proposal.status) && !isFrozenForSigning;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-hud-bg-elev/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/proposals')}
              className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
            </button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-semibold text-white">{proposal.title}</h1>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                  <StatusIcon className="w-3 h-3" />
                  {statusStyle.label}
                </span>
                {proposal.archived_at && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-hud-cream-mute/20 text-hud-cream-dim rounded-full text-xs">
                    <Archive className="w-3 h-3" />
                    Archived
                  </span>
                )}
                {sigStyle && sigStatus !== 'not_sent' && (
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${sigStyle.bg} ${sigStyle.text}`}>
                    <PenTool className="w-3 h-3" />
                    {sigStyle.label}
                  </span>
                )}
                {proposal.ai_context?.generated_at && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-hud-gold/20 text-hud-gold-soft rounded-full text-xs">
                    <Sparkles className="w-3 h-3" />
                    AI Generated
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 mt-1 text-sm text-hud-cream-dim">
                <span className="flex items-center gap-1">
                  <User className="w-4 h-4" />
                  {proposal.contact?.company || `${proposal.contact?.first_name} ${proposal.contact?.last_name}`}
                </span>
                <span className="flex items-center gap-1">
                  <DollarSign className="w-4 h-4" />
                  {formatCurrency(proposal.total_value, proposal.currency)}
                </span>
                {proposal.valid_until && (
                  <span className="flex items-center gap-1">
                    <Calendar className="w-4 h-4" />
                    Valid until {formatDateNumeric(proposal.valid_until)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {canEdit && proposal.status === 'draft' && (
              <Link
                to={`/proposals/${proposal.id}/build`}
                className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                AI Builder
              </Link>
            )}
            {canRequestSignature && (
              <button
                onClick={handleSendForSignature}
                className="flex items-center gap-2 px-4 py-2 bg-hud-teal hover:bg-hud-teal text-hud-bg-deep rounded-lg transition-colors"
              >
                <PenTool className="w-4 h-4" />
                Send for Signature
              </button>
            )}
            {proposal.status === 'accepted' && hasPermission('payments.manage') && canAccessPayments && (
              <button
                onClick={() => setShowConvertModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-hud-emerald-dim hover:bg-hud-emerald text-white hover:text-hud-bg-deep rounded-lg transition-colors"
              >
                <DollarSign className="w-4 h-4" />
                Convert to Invoice
              </button>
            )}
            {['draft', 'sent', 'viewed', 'accepted'].includes(proposal.status) && hasPermission('contracts.create') && (
              <button
                onClick={() => setShowContractModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors border border-hud-cream-mute"
              >
                <Scale className="w-4 h-4" />
                Convert to Contract
              </button>
            )}
            {proposal.status !== 'draft' && (
              <>
                <button
                  onClick={copyPublicLink}
                  className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors"
                >
                  <Copy className="w-4 h-4" />
                  Copy Link
                </button>
                <a
                  href={`/p/${proposal.public_token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Preview
                </a>
              </>
            )}
            <button
              onClick={handleExportPDF}
              disabled={isExportingPDF}
              className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {isExportingPDF ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileDown className="w-4 h-4" />
              )}
              Export PDF
            </button>
            <div className="relative">
              <button
                onClick={() => setShowActionMenu(!showActionMenu)}
                className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors"
              >
                <MoreVertical className="w-5 h-5 text-hud-cream-dim" />
              </button>
              {showActionMenu && (
                <AnchoredMenu className="w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50">
                  {canEdit && (
                    <button
                      onClick={handleDuplicateProposal}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                    >
                      <CopyIcon className="w-4 h-4" />
                      Duplicate
                    </button>
                  )}
                  {canEdit && !proposal.archived_at && (
                    <button
                      onClick={handleArchiveProposal}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                    >
                      <Archive className="w-4 h-4" />
                      Archive
                    </button>
                  )}
                  {canEdit && proposal.archived_at && (
                    <button
                      onClick={handleUnarchiveProposal}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                    >
                      <ArchiveRestore className="w-4 h-4" />
                      Unarchive
                    </button>
                  )}
                  {canDelete && (
                    <button
                      onClick={handleDeleteProposal}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-bg-elev transition-colors border-t border-hud-bg-elev"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </button>
                  )}
                </AnchoredMenu>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 mt-4">
          {(['content', 'pricing', 'signature', 'comments', 'activity'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-hud-bg-card text-white'
                  : 'text-hud-cream-dim hover:text-white hover:bg-hud-bg-card/50'
              }`}
            >
              {tab === 'content' && <FileText className="w-4 h-4 inline mr-2" />}
              {tab === 'pricing' && <DollarSign className="w-4 h-4 inline mr-2" />}
              {tab === 'signature' && <PenTool className="w-4 h-4 inline mr-2" />}
              {tab === 'comments' && <MessageSquare className="w-4 h-4 inline mr-2" />}
              {tab === 'activity' && <Activity className="w-4 h-4 inline mr-2" />}
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === 'comments' && comments.length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 bg-hud-gold/20 text-hud-gold-soft rounded text-xs">
                  {comments.length}
                </span>
              )}
              {tab === 'signature' && sigStatus === 'signed' && (
                <span className="ml-2 px-1.5 py-0.5 bg-hud-emerald/20 text-hud-emerald/40 rounded text-xs">
                  Signed
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {activeTab === 'content' && (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b border-hud-bg-elev/50">
              {((proposal as { brand?: string | null }).brand || proposal.contact?.brand || DEFAULT_BRAND) !== DEFAULT_BRAND ? (
                <span className="text-lg font-semibold text-white">{brandName((proposal as { brand?: string | null }).brand || proposal.contact?.brand)}</span>
              ) : (
                <img
                  src={FALLBACK_LOGO}
                  alt={user?.organization?.name || 'Logo'}
                  className="h-8 object-contain"
                />
              )}
            </div>

            {proposal.meeting_contexts && proposal.meeting_contexts.length > 0 && (
              <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
                <h3 className="text-sm font-medium text-hud-cream-soft mb-3 flex items-center gap-2">
                  <Video className="w-4 h-4 text-hud-gold-soft" />
                  Meeting Context
                </h3>
                <div className="space-y-2">
                  {proposal.meeting_contexts.map((ctx) => (
                    <div key={ctx.id} className="flex items-center justify-between p-3 bg-hud-bg-mid/50 rounded-lg">
                      <div>
                        <p className="text-white text-sm">{ctx.meeting_transcription?.meeting_title}</p>
                        <p className="text-xs text-hud-cream-dim">
                          {formatDateNumeric(ctx.meeting_transcription?.meeting_date || null)}
                        </p>
                      </div>
                      {ctx.meeting_transcription?.recording_url && (
                        <a
                          href={ctx.meeting_transcription.recording_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-hud-gold-soft hover:text-hud-gold-soft"
                        >
                          <Video className="w-3 h-3" />
                          View Recording
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <DocumentSectionsList
              sections={[...(proposal.sections || [])].sort((a, b) => a.sort_order - b.sort_order)}
              editingSectionId={editingSection}
              sectionContent={sectionContent}
              onSectionContentChange={setSectionContent}
              onEditClick={(section) => {
                setEditingSection(section.id);
                setSectionContent(section.content);
              }}
              onCancelEdit={() => setEditingSection(null)}
              onSave={(sectionId) => handleSectionUpdate(sectionId, sectionContent)}
              onDelete={handleDeleteSection}
              canEdit={canEdit}
              renderContent={(content) => sanitizeHtml(sanitizeProposalContent(content).replace(/\n/g, '<br>'))}
              emptyState={
                <div className="text-center py-12 text-hud-cream-dim">
                  <FileText className="w-10 h-10 mx-auto mb-3 opacity-50" />
                  <p>No content sections yet</p>
                  {canEdit && (
                    <Link
                      to={`/proposals/${proposal.id}/build`}
                      className="mt-4 inline-flex items-center gap-2 text-hud-gold-soft hover:text-hud-gold-soft"
                    >
                      <Sparkles className="w-4 h-4" />
                      Generate with AI
                    </Link>
                  )}
                </div>
              }
            />

            {isFeatureEnabled('entity_mentions') && (
              <ReferencesPanel targetType="proposal" targetId={proposal.id} />
            )}
          </div>
        )}

        {activeTab === 'pricing' && (
          <PricingTab
            proposal={proposal}
            canEdit={canEdit && !isFrozenForSigning}
            onReload={loadProposal}
            // adapter: PricingTab emits (message, type); context showToast takes (type, title)
            showToast={(message, type) => showToast(type, message)}
          />
        )}

        {activeTab === 'signature' && (
          <div className="max-w-3xl mx-auto space-y-6">
            {!signatureRequest && !sigStatus ? (
              <div className="text-center py-12 text-hud-cream-dim">
                <PenTool className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p>No signature request has been sent for this proposal</p>
                {canRequestSignature && (
                  <button
                    onClick={handleSendForSignature}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-hud-teal hover:bg-hud-teal text-hud-bg-deep rounded-lg transition-colors"
                  >
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
                      <Shield className="w-5 h-5 text-hud-gold-soft" />
                      Signature Status
                    </h3>
                    {sigStyle && (
                      <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${sigStyle.bg} ${sigStyle.text}`}>
                        {sigStyle.label}
                      </span>
                    )}
                  </div>

                  {signatureRequest && (
                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div>
                        <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">Signer</p>
                        <p className="text-white">{signatureRequest.signer_name}</p>
                        <p className="text-sm text-hud-cream-dim">{signatureRequest.signer_email}</p>
                      </div>
                      <div>
                        <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">Expires</p>
                        <p className="text-white">{formatDateNumeric(signatureRequest.expires_at)}</p>
                      </div>
                      {signatureRequest.viewed_at && (
                        <div>
                          <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">First Viewed</p>
                          <p className="text-white">{formatDateTimeNumeric(signatureRequest.viewed_at)}</p>
                        </div>
                      )}
                      {signatureRequest.signed_at && (
                        <div>
                          <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">Signed At</p>
                          <p className="text-hud-emerald font-medium">{formatDateTimeNumeric(signatureRequest.signed_at)}</p>
                        </div>
                      )}
                      {signatureRequest.declined_at && (
                        <div>
                          <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">Declined At</p>
                          <p className="text-hud-plum">{formatDateTimeNumeric(signatureRequest.declined_at)}</p>
                        </div>
                      )}
                      {signatureRequest.decline_reason && (
                        <div className="col-span-2">
                          <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">Decline Reason</p>
                          <p className="text-hud-cream-soft">{signatureRequest.decline_reason}</p>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">Email Delivery</p>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                          signatureRequest.send_status === 'sent'
                            ? 'bg-hud-emerald/20 text-hud-emerald/40'
                            : signatureRequest.send_status === 'failed'
                              ? 'bg-hud-plum/20 text-hud-plum/40'
                              : 'bg-hud-rust/20 text-hud-rust/40'
                        }`}>
                          {signatureRequest.send_status === 'sent' ? 'Sent' : signatureRequest.send_status === 'failed' ? 'Failed' : 'Pending'}
                        </span>
                      </div>
                      {signatureRequest.last_sent_at && (
                        <div>
                          <p className="text-xs text-hud-cream-mute uppercase tracking-wider mb-1">Last Sent</p>
                          <p className="text-white">{formatDateTimeNumeric(signatureRequest.last_sent_at)}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {signatureRequest?.send_status === 'failed' && signatureRequest.send_error && (
                    <div className="mb-4 p-3 bg-hud-plum/10 border border-hud-plum/30 rounded-lg flex items-start gap-3">
                      <AlertCircle className="w-4 h-4 text-hud-plum flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm text-hud-plum/40">{signatureRequest.send_error}</p>
                        {canSend && ['pending', 'viewed'].includes(signatureRequest.status) && (
                          <button
                            onClick={handleResendSignature}
                            disabled={isResending}
                            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-hud-plum/20 hover:bg-hud-plum/30 text-hud-plum/40 rounded text-xs font-medium transition-colors disabled:opacity-50"
                          >
                            {isResending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Retry Send
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {signatureRequest?.provider_message_id && (
                    <div className="mb-4">
                      <p className="text-xs text-hud-cream-mute">
                        Message ID: {signatureRequest.provider_message_id}
                      </p>
                    </div>
                  )}

                  {/* Not gated on final_signed_pdf_url: that column is empty on every record in
                      production — nothing has ever written it — so this button existed but could
                      never render. Gated on signed-ness AND the snapshot instead: a snapshot is
                      written at SEND time, so most proposals that have one were never signed (4 of
                      5 in production are expired), and offering "Download Signed PDF" for those
                      would hand someone a certificate reading "Not recorded" throughout. */}
                  {proposal.frozen_html_snapshot
                    && (proposal.signature_status === 'signed' || proposal.status === 'accepted') && (
                    <button
                      onClick={async () => {
                        try {
                          setIsDownloadingSigned(true);
                          await downloadSignedPdf('proposal', proposal.id);
                        } catch (err) {
                          console.error('Signed PDF export failed:', err);
                          showToast('error', err instanceof Error ? err.message : 'Could not build the signed PDF.');
                        } finally {
                          setIsDownloadingSigned(false);
                        }
                      }}
                      disabled={isDownloadingSigned}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-hud-emerald-dim/20 text-hud-emerald/40 border border-hud-emerald/30 rounded-lg hover:bg-hud-emerald-dim/30 transition-colors mb-4 disabled:opacity-50"
                    >
                      {isDownloadingSigned ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                      {isDownloadingSigned ? 'Building PDF…' : 'Download Signed PDF'}
                    </button>
                  )}

                  {signatureRequest && ['pending', 'viewed'].includes(signatureRequest.status) && canSend && (
                    <div className="flex items-center gap-2 pt-4 border-t border-hud-bg-elev">
                      <button
                        onClick={handleResendSignature}
                        disabled={isResending}
                        className="flex items-center gap-2 px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute text-white rounded-lg transition-colors disabled:opacity-50"
                      >
                        {isResending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                        Resend
                      </button>
                      <button
                        onClick={handleVoidSignature}
                        disabled={isVoiding}
                        className="flex items-center gap-2 px-4 py-2 text-hud-plum hover:text-hud-plum/40 border border-hud-plum/30 hover:border-hud-plum/50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {isVoiding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
                        Void
                      </button>
                    </div>
                  )}
                </div>

                <DocumentAuditTrail
                  events={auditEvents}
                  iconMap={AUDIT_EVENT_ICONS}
                />
              </>
            )}
          </div>
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
              switch (type) {
                case 'created': return <Plus className="w-4 h-4 text-hud-emerald" />;
                case 'sent': return <Send className="w-4 h-4 text-hud-gold-soft" />;
                case 'viewed': return <Eye className="w-4 h-4 text-hud-rust" />;
                case 'status_changed': return <Activity className="w-4 h-4 text-hud-cream-dim" />;
                case 'ai_generated': return <Sparkles className="w-4 h-4 text-hud-gold-soft" />;
                case 'updated': return <Edit3 className="w-4 h-4 text-hud-cream-dim" />;
                case 'commented': return <MessageSquare className="w-4 h-4 text-hud-cream-dim" />;
                default: return null;
              }
            }}
          />
        )}
      </div>

      {showConvertModal && proposal && canAccessPayments && (
        <ConvertToInvoiceModal
          proposal={proposal}
          onClose={() => setShowConvertModal(false)}
          onConverted={() => {
            setShowConvertModal(false);
            loadProposal();
          }}
        />
      )}

      {showSignatureModal && proposal && (
        <SendForSignatureModal
          proposal={proposal}
          onClose={() => setShowSignatureModal(false)}
          onSent={() => {
            setShowSignatureModal(false);
            loadProposal();
          }}
        />
      )}

      {showContractModal && proposal && (
        <ConvertToContractModal
          proposal={proposal}
          onClose={() => setShowContractModal(false)}
          onConverted={() => {
            setShowContractModal(false);
            loadProposal();
          }}
        />
      )}
    </div>
  );
}
