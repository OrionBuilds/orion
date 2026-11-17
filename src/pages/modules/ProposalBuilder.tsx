import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getProposalById, linkMeetingToProposal, unlinkMeetingFromProposal } from '../../services/proposals';
import { callEdgeFunction } from '../../lib/edgeFunction';
import { MeetingContextPicker } from '../../components/meetings/MeetingContextPicker';
import { ACCEPTED_TYPES } from '../../utils/fileParser';
import { useFileUpload } from '../../hooks/useFileUpload';
import { SourceDocumentsPicker } from '../../components/proposals/SourceDocumentsPicker';
import { SourcesUsedSummary } from '../../components/proposals/SourcesUsedSummary';
import { selectionToPayload, type SourceSelection, type SourcesUsed } from '../../services/proposalSources';
import type { Proposal, ProposalSectionType } from '../../types';
import {
  ArrowLeft,
  FileText,
  Sparkles,
  Loader2,
  Video,
  CheckCircle,
  ChevronRight,
  ListChecks,
  Wand2,
  AlertCircle,
  Upload,
  X,
  FileUp,
  File,
} from 'lucide-react';
import { formatFileSize } from '../../utils/formatters';

type BuilderStep = 'meetings' | 'sections' | 'generate' | 'review';

const SECTION_OPTIONS: { type: ProposalSectionType; label: string; description: string }[] = [
  { type: 'intro', label: 'Introduction', description: 'Opening statement and executive summary' },
  { type: 'scope', label: 'Scope of Work', description: 'Detailed project scope and objectives' },
  { type: 'deliverables', label: 'Deliverables', description: 'What will be delivered' },
  { type: 'timeline', label: 'Timeline', description: 'Project schedule and milestones' },
  { type: 'pricing', label: 'Pricing', description: 'Cost breakdown and payment terms' },
  { type: 'terms', label: 'Terms & Conditions', description: 'Legal terms and conditions' },
];

export function ProposalBuilder() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [selectedMeetings, setSelectedMeetings] = useState<string[]>([]);
  const [selectedSections, setSelectedSections] = useState<ProposalSectionType[]>(['intro', 'scope', 'deliverables', 'pricing']);
  const [customInstructions, setCustomInstructions] = useState('');
  const [includeContactHistory, setIncludeContactHistory] = useState(true);
  const [includeOpportunityData, setIncludeOpportunityData] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<BuilderStep>('meetings');
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

  useEffect(() => {
    if (id) {
      loadData();
    }
  }, [id]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const proposalData = await getProposalById(id!);
      setProposal(proposalData);

      const linkedMeetingIds = proposalData?.meeting_contexts?.map(mc => mc.meeting_transcription_id) || [];
      setSelectedMeetings(linkedMeetingIds);

    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMeeting = async (meetingId: string) => {
    if (!proposal) return;

    const isSelected = selectedMeetings.includes(meetingId);
    const newSelected = isSelected
      ? selectedMeetings.filter(id => id !== meetingId)
      : [...selectedMeetings, meetingId];

    setSelectedMeetings(newSelected);

    try {
      if (isSelected) {
        await unlinkMeetingFromProposal(proposal.id, meetingId);
      } else {
        await linkMeetingToProposal(proposal.id, meetingId, proposal.org_id);
      }
    } catch (err) {
      console.error('Failed to update meeting link:', err);
      setSelectedMeetings(selectedMeetings);
    }
  };

  const toggleSection = (sectionType: ProposalSectionType) => {
    setSelectedSections(prev =>
      prev.includes(sectionType)
        ? prev.filter(s => s !== sectionType)
        : [...prev, sectionType]
    );
  };

  const handleGenerate = async () => {
    if (!proposal || !user) return;

    try {
      setIsGenerating(true);
      setGenerationError(null);

      const response = await callEdgeFunction('proposal-ai-generate', {
        proposal_id: proposal.id,
        contact_id: proposal.contact_id,
        opportunity_id: proposal.opportunity_id,
        meeting_ids: selectedMeetings,
        template_id: proposal.template_id,
        custom_instructions: customInstructions || undefined,
        sections_to_generate: selectedSections,
        include_contact_history: includeContactHistory,
        include_opportunity_data: includeOpportunityData,
        user_id: user.id,
        uploaded_documents: uploadedFiles.length > 0
          ? uploadedFiles.map((f) => ({ name: f.name, text: f.text }))
          : undefined,
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
      console.error('Failed to generate:', err);
      setGenerationError(err instanceof Error ? err.message : 'Failed to generate proposal content');
    } finally {
      setIsGenerating(false);
    }
  };

  const steps: { key: BuilderStep; label: string; icon: typeof FileText }[] = [
    { key: 'meetings', label: 'Context', icon: Video },
    { key: 'sections', label: 'Choose Sections', icon: ListChecks },
    { key: 'generate', label: 'Generate', icon: Sparkles },
    { key: 'review', label: 'Review', icon: FileText },
  ];

  const currentStepIndex = steps.findIndex(s => s.key === currentStep);

  const totalSelected = selectedMeetings.length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-hud-cream-dim">
        <FileText className="w-12 h-12 mb-4 opacity-50" />
        <p>Proposal not found</p>
        <Link to="/proposals" className="mt-4 text-hud-gold-soft hover:text-hud-gold-soft">
          Back to Proposals
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-hud-bg-mid">
      <div className="px-6 py-4 border-b border-hud-bg-elev/50">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(`/proposals/${proposal.id}`)}
              className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
            </button>
            <div>
              <h1 className="text-xl font-semibold text-white flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-hud-gold-soft" />
                AI Proposal Builder
              </h1>
              <p className="text-sm text-hud-cream-dim mt-0.5">{proposal.title}</p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center">
          {steps.map((step, index) => (
            <div key={step.key} className="flex items-center">
              <button
                onClick={() => index <= currentStepIndex && setCurrentStep(step.key)}
                disabled={index > currentStepIndex}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  currentStep === step.key
                    ? 'bg-hud-gold/20 text-hud-gold-soft'
                    : index < currentStepIndex
                    ? 'text-hud-emerald hover:bg-hud-bg-card'
                    : 'text-hud-cream-mute cursor-not-allowed'
                }`}
              >
                {index < currentStepIndex ? (
                  <CheckCircle className="w-5 h-5" />
                ) : (
                  <step.icon className="w-5 h-5" />
                )}
                <span className="text-sm font-medium">{step.label}</span>
              </button>
              {index < steps.length - 1 && (
                <ChevronRight className="w-5 h-5 text-hud-cream-mute mx-2" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          {currentStep === 'meetings' && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <h2 className="text-lg font-semibold text-white">Provide Context</h2>
                <p className="text-hud-cream-dim mt-1">
                  Pick the meetings, attached documents (including SAM.gov solicitation files) and project context the AI should read, and upload anything else.
                </p>
              </div>

              <SourceDocumentsPicker
                opportunityId={proposal.opportunity_id}
                contactId={proposal.contact_id}
                proposalId={proposal.id}
                isSamGov={proposal.opportunity?.source === 'sam_gov'}
                onChange={setSourceSelection}
              />

              {/* Upload Documents */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-hud-cream-soft uppercase tracking-wider flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Upload Documents
                </h3>
                <p className="text-xs text-hud-cream-mute">
                  PDF, DOCX, or TXT files up to 10MB
                </p>
              </div>

              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 ${
                  isDragOver
                    ? 'border-hud-gold-soft bg-hud-gold/10'
                    : 'border-hud-cream-mute bg-hud-bg-card/30 hover:border-hud-cream-mute hover:bg-hud-bg-card/50'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_TYPES}
                  multiple
                  onChange={(e) => e.target.files && handleFiles(e.target.files)}
                  className="hidden"
                />
                {isParsingFile ? (
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
                    <p className="text-hud-cream-soft text-sm">Extracting text from document...</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                      isDragOver ? 'bg-hud-gold/20' : 'bg-hud-bg-elev/50'
                    }`}>
                      <FileUp className={`w-6 h-6 ${isDragOver ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`} />
                    </div>
                    <div>
                      <p className="text-hud-cream-soft text-sm">
                        <span className="text-hud-gold-soft font-medium">Click to upload</span> or drag and drop
                      </p>
                      <p className="text-hud-cream-mute text-xs mt-1">
                        Scope of work, meeting notes, project briefs, RFPs
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {fileError && (
                <div className="p-3 bg-hud-plum/10 border border-hud-plum/30 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-hud-plum flex-shrink-0" />
                  <p className="text-hud-plum/40 text-sm">{fileError}</p>
                </div>
              )}

              {uploadedFiles.length > 0 && (
                <div className="space-y-2">
                  {uploadedFiles.map((file) => (
                    <div
                      key={file.name}
                      className="flex items-center gap-3 p-3 bg-hud-bg-card/60 rounded-lg border border-hud-bg-elev group"
                    >
                      <div className="w-9 h-9 rounded-lg bg-hud-gold/10 flex items-center justify-center flex-shrink-0">
                        <File className="w-4 h-4 text-hud-gold-soft" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{file.name}</p>
                        <div className="flex items-center gap-3 text-xs text-hud-cream-dim">
                          <span>{formatFileSize(file.size)}</span>
                          {file.pageCount && <span>{file.pageCount} page{file.pageCount !== 1 ? 's' : ''}</span>}
                          <span>{file.text.length.toLocaleString()} chars extracted</span>
                        </div>
                      </div>
                      <button
                        onClick={() => removeFile(file.name)}
                        className="p-1.5 rounded-md text-hud-cream-mute hover:text-hud-plum hover:bg-hud-plum/10 transition-colors opacity-0 group-hover:opacity-100 reveal-on-touch"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Meetings (Google Meet / Teams transcripts, imported transcripts): client-linked or all. */}
              <MeetingContextPicker
                contactId={proposal.contact_id}
                selectedIds={selectedMeetings}
                onToggle={toggleMeeting}
              />

              <div className="flex items-center justify-between pt-4">
                {totalSelected > 0 && (
                  <span className="text-sm text-hud-cream-dim">
                    <span className="text-hud-gold-soft font-medium">{totalSelected}</span> meeting{totalSelected !== 1 ? 's' : ''} selected
                  </span>
                )}
                <div className={totalSelected > 0 ? '' : 'ml-auto'}>
                  <button
                    onClick={() => setCurrentStep('sections')}
                    className="flex items-center gap-2 px-6 py-2.5 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep rounded-lg transition-colors"
                  >
                    Continue
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {currentStep === 'sections' && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <h2 className="text-lg font-semibold text-white">Choose Sections to Generate</h2>
                <p className="text-hud-cream-dim mt-1">
                  Select which proposal sections the AI should generate
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {SECTION_OPTIONS.map((section) => (
                  <button
                    key={section.type}
                    onClick={() => toggleSection(section.type)}
                    className={`p-4 rounded-lg border transition-colors text-left ${
                      selectedSections.includes(section.type)
                        ? 'border-hud-gold bg-hud-gold/10'
                        : 'border-hud-bg-elev bg-hud-bg-card/50 hover:border-hud-cream-mute'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                        selectedSections.includes(section.type)
                          ? 'border-hud-gold bg-hud-gold'
                          : 'border-hud-cream-mute'
                      }`}>
                        {selectedSections.includes(section.type) && (
                          <CheckCircle className="w-3 h-3 text-white" />
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-white">{section.label}</p>
                        <p className="text-sm text-hud-cream-dim">{section.description}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <div className="flex justify-between pt-4">
                <button
                  onClick={() => setCurrentStep('meetings')}
                  className="flex items-center gap-2 px-4 py-2 text-hud-cream-dim hover:text-white transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
                <button
                  onClick={() => setCurrentStep('generate')}
                  disabled={selectedSections.length === 0}
                  className="flex items-center gap-2 px-6 py-2.5 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg transition-colors"
                >
                  Continue
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {currentStep === 'generate' && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <h2 className="text-lg font-semibold text-white">Configure Generation</h2>
                <p className="text-hud-cream-dim mt-1">
                  Add any additional instructions and review your settings
                </p>
              </div>

              <div className="bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev p-6 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <h3 className="text-sm font-medium text-hud-cream-soft mb-3">Context Sources</h3>
                    <div className="space-y-1">
                      {selectedMeetings.length > 0 && (
                        <p className="text-white">{selectedMeetings.length} meeting{selectedMeetings.length !== 1 ? 's' : ''}</p>
                      )}
                      {uploadedFiles.length > 0 && (
                        <p className="text-white">{uploadedFiles.length} uploaded document{uploadedFiles.length !== 1 ? 's' : ''}</p>
                      )}
                      {sourceSelection.fileIds.length > 0 && (
                        <p className="text-white">{sourceSelection.fileIds.length} attached document{sourceSelection.fileIds.length !== 1 ? 's' : ''}</p>
                      )}
                      {sourceSelection.projectIds.length > 0 && (
                        <p className="text-white">{sourceSelection.projectIds.length} project{sourceSelection.projectIds.length !== 1 ? 's' : ''}</p>
                      )}
                      {selectedMeetings.length === 0 && uploadedFiles.length === 0 &&
                        sourceSelection.fileIds.length === 0 && sourceSelection.projectIds.length === 0 && (
                        <p className="text-hud-cream-mute">None</p>
                      )}
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-hud-cream-soft mb-3">Selected Sections</h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedSections.map((s) => (
                        <span key={s} className="px-2 py-1 bg-hud-gold/20 text-hud-gold-soft rounded text-sm">
                          {SECTION_OPTIONS.find(o => o.type === s)?.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={includeContactHistory}
                      onChange={(e) => setIncludeContactHistory(e.target.checked)}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold"
                    />
                    <div>
                      <span className="text-white">Include contact history</span>
                      <p className="text-sm text-hud-cream-dim">Use notes and timeline events from the contact</p>
                    </div>
                  </label>

                  {proposal.opportunity_id && (
                    <label className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={includeOpportunityData}
                        onChange={(e) => setIncludeOpportunityData(e.target.checked)}
                        className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold"
                      />
                      <div>
                        <span className="text-white">Include opportunity data</span>
                        <p className="text-sm text-hud-cream-dim">Use deal value, pipeline stage, and source</p>
                      </div>
                    </label>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                    Additional Instructions (Optional)
                  </label>
                  <textarea
                    value={customInstructions}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                    placeholder="Add any specific instructions for the AI, such as tone preferences, specific points to emphasize, or topics to avoid..."
                    className="w-full h-32 px-4 py-3 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim resize-none focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                  />
                </div>
              </div>

              {generationError && (
                <div className="p-4 bg-hud-plum/10 border border-hud-plum/30 rounded-lg flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0" />
                  <p className="text-hud-plum/40">{generationError}</p>
                </div>
              )}

              <div className="flex justify-between pt-4">
                <button
                  onClick={() => setCurrentStep('sections')}
                  className="flex items-center gap-2 px-4 py-2 text-hud-cream-dim hover:text-white transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-hud-gold-deep to-blue-600 hover:from-hud-gold hover:to-blue-500 disabled:from-hud-bg-elev disabled:to-hud-bg-elev disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-4 h-4" />
                      Generate Proposal
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {currentStep === 'review' && (
            <div className="space-y-6">
              <div className="text-center mb-8">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-hud-emerald/20 flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-hud-emerald" />
                </div>
                <h2 className="text-lg font-semibold text-white">Generation Complete!</h2>
                <p className="text-hud-cream-dim mt-1">
                  Your proposal content has been generated. Review and edit it on the proposal page.
                </p>
              </div>

              <SourcesUsedSummary sources={sourcesUsed} />

              <div className="flex justify-center gap-4">
                <button
                  onClick={() => setCurrentStep('meetings')}
                  className="flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-white rounded-lg transition-colors"
                >
                  <Sparkles className="w-4 h-4" />
                  Generate More
                </button>
                <button
                  onClick={() => navigate(`/proposals/${proposal.id}`)}
                  className="flex items-center gap-2 px-6 py-2.5 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep rounded-lg transition-colors"
                >
                  <FileText className="w-4 h-4" />
                  View Proposal
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
