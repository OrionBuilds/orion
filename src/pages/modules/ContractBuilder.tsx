import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  getContractById,
  updateContract,
  getContractMeetingIds,
  linkMeetingToContract,
  unlinkMeetingFromContract,
} from '../../services/contracts';
import { callEdgeFunction } from '../../lib/edgeFunction';
import { ACCEPTED_TYPES } from '../../utils/fileParser';
import { useFileUpload } from '../../hooks/useFileUpload';
import { MeetingContextPicker } from '../../components/meetings/MeetingContextPicker';
import { SourceDocumentsPicker } from '../../components/proposals/SourceDocumentsPicker';
import { SourcesUsedSummary } from '../../components/proposals/SourcesUsedSummary';
import { selectionToPayload, type SourceSelection, type SourcesUsed } from '../../services/proposalSources';
import type { Contract, ContractType } from '../../types';
import {
  ArrowLeft, Scale, Sparkles, Loader2, Video, CheckCircle, ChevronRight,
  FileText, AlertCircle, Upload, X, File, Calendar, MapPin, MessageSquare,
  DollarSign, ScrollText,
} from 'lucide-react';

type BuilderStep = 'context' | 'terms' | 'generate' | 'review';

const CONTRACT_TYPE_OPTIONS: { value: ContractType; label: string; description: string }[] = [
  { value: 'freelance_service', label: 'Freelance Service Agreement', description: 'One-time project with defined deliverables' },
  { value: 'retainer', label: 'Retainer Agreement', description: 'Ongoing monthly engagement' },
  { value: 'partnership', label: 'Partnership Agreement', description: 'Co-venture with shared revenue' },
  { value: 'nda', label: 'Non-Disclosure Agreement', description: 'Pre-engagement confidentiality' },
];

/**
 * Multi-step contract builder, mirroring ProposalBuilder.
 * Context (client meetings + reference docs) -> Terms -> Generate -> Review.
 */
export function ContractBuilder() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [contract, setContract] = useState<Contract | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState<BuilderStep>('context');

  const [selectedMeetings, setSelectedMeetings] = useState<string[]>([]);
  const [sourceSelection, setSourceSelection] = useState<SourceSelection>({ loaded: false, fileIds: [], projectIds: [] });
  const [sourcesUsed, setSourcesUsed] = useState<SourcesUsed | null>(null);
  const {
    uploadedFiles,
    isParsingFile,
    fileError,
    isDragOver,
    fileInputRef,
    handleFiles,
    removeFile,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  } = useFileUpload();

  const [contractType, setContractType] = useState<ContractType>('freelance_service');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [governingLawState, setGoverningLawState] = useState('');
  const [totalValue, setTotalValue] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const data = await getContractById(id!);
      setContract(data);
      if (data) {
        setContractType(data.contract_type);
        setEffectiveDate(data.effective_date || '');
        setGoverningLawState(data.governing_law_state || '');
        setTotalValue(data.total_value ? String(data.total_value) : '');
        setCustomInstructions(data.custom_instructions || '');
        const linked = await getContractMeetingIds(data.id).catch(() => []);
        setSelectedMeetings(linked);
      }
    } catch (err) {
      console.error('Failed to load contract:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMeeting = async (meetingId: string) => {
    if (!contract) return;
    const isSelected = selectedMeetings.includes(meetingId);
    const next = isSelected
      ? selectedMeetings.filter((m) => m !== meetingId)
      : [...selectedMeetings, meetingId];
    setSelectedMeetings(next);
    try {
      if (isSelected) {
        await unlinkMeetingFromContract(contract.id, meetingId);
      } else {
        await linkMeetingToContract(contract.id, meetingId, contract.org_id);
      }
    } catch (err) {
      console.error('Failed to update meeting link:', err);
      setSelectedMeetings(selectedMeetings); // revert
    }
  };

  /** Persist terms before generating so the contract reflects what the user set. */
  const saveTerms = async () => {
    if (!contract) return;
    const parsedValue = totalValue ? Number(totalValue) : 0;
    await updateContract(contract.id, {
      total_value: Number.isFinite(parsedValue) ? parsedValue : 0,
      effective_date: effectiveDate || null,
      governing_law_state: governingLawState || null,
    }).catch((e) => console.error('Failed to save contract terms:', e));
  };

  const handleGenerate = async () => {
    if (!contract || !user) return;
    try {
      setIsGenerating(true);
      setGenerationError(null);
      await saveTerms();

      const response = await callEdgeFunction('contract-ai-generate', {
        contract_id: contract.id,
        proposal_id: contract.proposal_id || undefined,
        contact_id: contract.contact_id,
        opportunity_id: contract.opportunity_id || undefined,
        contract_type: contractType,
        custom_instructions: customInstructions || undefined,
        meeting_ids: selectedMeetings,
        uploaded_documents: uploadedFiles.length > 0
          ? uploadedFiles.map((f) => ({ name: f.name, text: f.text }))
          : undefined,
        user_id: user.id,
        ...selectionToPayload(sourceSelection),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Generation failed');
      }
      const result = await response.json().catch(() => null);
      setSourcesUsed(result?.sources_used ?? null);
      setCurrentStep('review');
    } catch (err) {
      console.error('Failed to generate contract:', err);
      setGenerationError(err instanceof Error ? err.message : 'Failed to generate contract sections');
    } finally {
      setIsGenerating(false);
    }
  };

  const steps: { key: BuilderStep; label: string; icon: typeof FileText }[] = [
    { key: 'context', label: 'Context', icon: Video },
    { key: 'terms', label: 'Terms', icon: ScrollText },
    { key: 'generate', label: 'Generate', icon: Sparkles },
    { key: 'review', label: 'Review', icon: FileText },
  ];
  const currentStepIndex = steps.findIndex((s) => s.key === currentStep);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-hud-cream-dim">
        <Scale className="w-12 h-12 mb-4 opacity-50" />
        <p>Contract not found</p>
        <Link to="/contracts" className="mt-4 text-hud-gold-soft hover:text-hud-gold-soft">
          Back to Contracts
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-hud-bg-mid">
      <div className="px-6 py-4 border-b border-hud-bg-elev/50">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => navigate(`/contracts/${contract.id}`)}
            className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-white flex items-center gap-2 truncate">
              <Scale className="w-5 h-5 text-hud-gold-soft flex-shrink-0" />
              {contract.title}
            </h1>
            <p className="text-sm text-hud-cream-dim">AI Contract Builder</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {steps.map((step, i) => {
            const Icon = step.icon;
            const isActive = step.key === currentStep;
            const isDone = i < currentStepIndex;
            return (
              <div key={step.key} className="flex items-center">
                <div
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${
                    isActive
                      ? 'bg-hud-gold/15 text-hud-gold-soft border border-hud-gold/40'
                      : isDone
                        ? 'text-hud-emerald'
                        : 'text-hud-cream-mute'
                  }`}
                >
                  {isDone ? <CheckCircle className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                  {step.label}
                </div>
                {i < steps.length - 1 && <ChevronRight className="w-4 h-4 text-hud-cream-mute mx-1" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {currentStep === 'context' && (
            <>
              <div>
                <h2 className="text-lg font-medium text-white">Provide Context</h2>
                <p className="text-sm text-hud-cream-dim mt-1">
                  Ground the contract in what was actually agreed with the client.
                </p>
              </div>

              <SourceDocumentsPicker
                opportunityId={contract.opportunity_id || contract.opportunity?.id || null}
                contactId={contract.contact_id}
                proposalId={contract.proposal_id}
                isSamGov={contract.opportunity?.source === 'sam_gov'}
                onChange={setSourceSelection}
              />

              <div className="space-y-2">
                <h3 className="text-sm font-medium text-hud-cream-soft uppercase tracking-wider flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Reference Documents
                </h3>
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                    isDragOver ? 'border-hud-gold bg-hud-gold/5' : 'border-hud-bg-elev hover:border-hud-cream-mute'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ACCEPTED_TYPES}
                    className="hidden"
                    onChange={(e) => e.target.files && handleFiles(e.target.files)}
                  />
                  {isParsingFile ? (
                    <Loader2 className="w-5 h-5 text-hud-gold-soft animate-spin mx-auto" />
                  ) : (
                    <p className="text-sm text-hud-cream-dim">
                      Drop an existing MSA, SOW or spec here, or click to browse
                    </p>
                  )}
                </div>
                {fileError && (
                  <p className="text-xs text-hud-plum flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {fileError}
                  </p>
                )}
                {uploadedFiles.length > 0 && (
                  <div className="space-y-1.5">
                    {uploadedFiles.map((f, i) => (
                      <div
                        key={`${f.name}-${i}`}
                        className="flex items-center justify-between px-3 py-2 bg-hud-bg-card/60 border border-hud-bg-elev rounded-lg"
                      >
                        <span className="flex items-center gap-2 text-sm text-hud-cream-soft truncate">
                          <File className="w-4 h-4 text-hud-cream-mute flex-shrink-0" />
                          {f.name}
                        </span>
                        <button
                          onClick={() => removeFile(f.name)}
                          className="p-1 text-hud-cream-mute hover:text-white"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <MeetingContextPicker
                contactId={contract.contact_id}
                selectedIds={selectedMeetings}
                onToggle={toggleMeeting}
              />
            </>
          )}

          {currentStep === 'terms' && (
            <>
              <div>
                <h2 className="text-lg font-medium text-white">Contract Terms</h2>
                <p className="text-sm text-hud-cream-dim mt-1">
                  These are written into the agreement verbatim — the AI won't invent them.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">Contract Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {CONTRACT_TYPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setContractType(opt.value)}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        contractType === opt.value
                          ? 'border-hud-gold bg-hud-gold/10'
                          : 'border-hud-bg-elev bg-hud-bg-card/50 hover:border-hud-cream-mute'
                      }`}
                    >
                      <p className="text-sm text-white font-medium">{opt.label}</p>
                      <p className="text-xs text-hud-cream-dim mt-0.5">{opt.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                    <DollarSign className="w-4 h-4 inline mr-1" />
                    Total Value
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={totalValue}
                    onChange={(e) => setTotalValue(e.target.value)}
                    placeholder="0"
                    className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                    <Calendar className="w-4 h-4 inline mr-1" />
                    Effective Date
                  </label>
                  <input
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                    <MapPin className="w-4 h-4 inline mr-1" />
                    Governing Law
                  </label>
                  <input
                    type="text"
                    value={governingLawState}
                    onChange={(e) => setGoverningLawState(e.target.value)}
                    placeholder="e.g. Florida"
                    className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  <MessageSquare className="w-4 h-4 inline mr-1" />
                  Custom Instructions
                </label>
                <textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  rows={4}
                  placeholder="Specific clauses, payment terms, exclusions..."
                  className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50 resize-none"
                />
              </div>
            </>
          )}

          {currentStep === 'generate' && (
            <>
              <div>
                <h2 className="text-lg font-medium text-white">Generate Contract</h2>
                <p className="text-sm text-hud-cream-dim mt-1">
                  All standard sections are drafted from the context and terms below.
                </p>
              </div>

              <div className="p-4 bg-hud-bg-card/50 border border-hud-bg-elev rounded-lg space-y-2 text-sm">
                <p className="text-hud-cream-soft font-medium">Context Sources</p>
                <ul className="text-hud-cream-dim space-y-1">
                  <li>• {selectedMeetings.length} client meeting{selectedMeetings.length !== 1 ? 's' : ''}</li>
                  <li>• {uploadedFiles.length} uploaded reference document{uploadedFiles.length !== 1 ? 's' : ''}</li>
                  <li>• {sourceSelection.fileIds.length} attached document{sourceSelection.fileIds.length !== 1 ? 's' : ''}</li>
                  {sourceSelection.projectIds.length > 0 && (
                    <li>• {sourceSelection.projectIds.length} project{sourceSelection.projectIds.length !== 1 ? 's' : ''}</li>
                  )}
                  <li>• {contract.proposal_id ? 'Source proposal included' : 'No source proposal'}</li>
                  <li>• {CONTRACT_TYPE_OPTIONS.find((o) => o.value === contractType)?.label}</li>
                </ul>
              </div>

              <div className="p-4 rounded-lg bg-hud-rust/10 border border-hud-rust/30 text-sm text-hud-rust/90">
                AI-drafted agreements are a starting point, not legal advice. Review every
                clause before sending for signature.
              </div>

              {generationError && (
                <div className="p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-sm text-hud-plum/40 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  {generationError}
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-hud-gold-deep hover:bg-hud-gold-deep disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
              >
                {isGenerating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                {isGenerating ? 'Drafting contract sections…' : 'Generate Contract'}
              </button>
            </>
          )}

          {currentStep === 'review' && (
            <div className="text-center py-12 space-y-4">
              <CheckCircle className="w-12 h-12 text-hud-emerald mx-auto" />
              <div>
                <h2 className="text-lg font-medium text-white">Contract drafted</h2>
                <p className="text-sm text-hud-cream-dim mt-1">
                  Review each section, then send it for signature.
                </p>
              </div>
              <div className="max-w-xl mx-auto">
                <SourcesUsedSummary sources={sourcesUsed} />
              </div>
              <button
                onClick={() => navigate(`/contracts/${contract.id}`)}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg text-sm font-medium transition-colors"
              >
                <FileText className="w-4 h-4" />
                View Contract
              </button>
            </div>
          )}
        </div>
      </div>

      {currentStep !== 'review' && (
        <div className="px-6 py-4 border-t border-hud-bg-elev/50 flex items-center justify-between">
          <button
            onClick={() => {
              const prev = steps[currentStepIndex - 1];
              if (prev) setCurrentStep(prev.key);
              else navigate(`/contracts/${contract.id}`);
            }}
            className="px-4 py-2 text-hud-cream-dim hover:text-white text-sm transition-colors"
          >
            Back
          </button>
          {currentStep !== 'generate' && (
            <button
              onClick={async () => {
                if (currentStep === 'terms') await saveTerms();
                const next = steps[currentStepIndex + 1];
                if (next) setCurrentStep(next.key);
              }}
              className="flex items-center gap-2 px-5 py-2.5 bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg text-sm font-medium transition-colors"
            >
              Continue
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
