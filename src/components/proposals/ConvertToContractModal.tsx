import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { createContractFromProposal, linkMeetingToContract } from '../../services/contracts';
import { MeetingContextPicker } from '../meetings/MeetingContextPicker';
import { callEdgeFunction } from '../../lib/edgeFunction';
import type { Proposal, ContractType } from '../../types';
import { X, FileText, Loader2, Scale, Sparkles, Calendar, MapPin, MessageSquare } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface ConvertToContractModalProps {
  proposal: Proposal;
  onClose: () => void;
  onConverted: () => void;
}

const CONTRACT_TYPE_OPTIONS: { value: ContractType; label: string; description: string }[] = [
  { value: 'freelance_service', label: 'Freelance Service Agreement', description: 'One-time project with defined deliverables and milestones' },
  { value: 'retainer', label: 'Retainer Agreement', description: 'Ongoing monthly engagement with recurring scope' },
  { value: 'partnership', label: 'Partnership Agreement', description: 'Co-venture with shared responsibilities and revenue' },
  { value: 'nda', label: 'Non-Disclosure Agreement', description: 'Pre-engagement confidentiality protection' },
];

export function ConvertToContractModal({ proposal, onClose, onConverted }: ConvertToContractModalProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [contractType, setContractType] = useState<ContractType>('freelance_service');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [governingLawState, setGoverningLawState] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedMeetings, setSelectedMeetings] = useState<string[]>([]);
  const [generateWithAI, setGenerateWithAI] = useState(true);
  const [isConverting, setIsConverting] = useState(false);
  const [step, setStep] = useState<'configure' | 'generating'>('configure');
  const [generationProgress, setGenerationProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleConvert = async () => {
    if (!user) return;

    try {
      setIsConverting(true);
      setError(null);

      setStep('generating');
      setGenerationProgress('Creating contract record...');

      const contract = await createContractFromProposal(
        proposal.id,
        user.organization_id,
        user.id,
        {
          contract_type: contractType,
          effective_date: effectiveDate || undefined,
          governing_law_state: governingLawState || undefined,
          custom_instructions: customInstructions || undefined,
        }
      );

      // Persist the chosen meetings so the contract records what it was
      // drafted from, not just what the model saw.
      if (selectedMeetings.length > 0) {
        setGenerationProgress('Linking meeting context...');
        await Promise.all(
          selectedMeetings.map((meetingId) =>
            linkMeetingToContract(contract.id, meetingId, user.organization_id).catch((e) =>
              console.error('Failed to link meeting to contract:', e)
            )
          )
        );
      }

      if (generateWithAI) {
        setGenerationProgress('AI is drafting contract sections — this may take a minute...');
        try {
          await callEdgeFunction('contract-ai-generate', {
            contract_id: contract.id,
            proposal_id: proposal.id,
            contact_id: proposal.contact_id,
            opportunity_id: proposal.opportunity_id || undefined,
            contract_type: contractType,
            custom_instructions: customInstructions || undefined,
            meeting_ids: selectedMeetings,
            user_id: user.id,
          });
        } catch (aiErr) {
          console.error('AI generation failed, contract created without sections:', aiErr);
        }
      }

      navigate(`/contracts/${contract.id}`);
      onConverted();
    } catch (err) {
      console.error('Failed to convert proposal to contract:', err);
      setError(err instanceof Error ? err.message : 'Failed to create contract. Please try again.');
      setStep('configure');
    } finally {
      setIsConverting(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-hud-bg-elev flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Scale className="w-5 h-5 text-hud-gold-soft" />
              Convert to Contract
            </h2>
            <p className="text-sm text-hud-cream-dim mt-1">
              Generate a professional contract from this proposal
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isConverting}
            className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        {step === 'generating' ? (
          <div className="flex-1 flex flex-col items-center justify-center p-12">
            <div className="w-16 h-16 rounded-full bg-hud-gold/10 flex items-center justify-center mb-6">
              <Sparkles className="w-8 h-8 text-hud-gold-soft animate-pulse" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">Generating Contract</h3>
            <p className="text-sm text-hud-cream-dim text-center max-w-sm">{generationProgress}</p>
            <div className="mt-6 flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-hud-gold-soft animate-spin" />
              <span className="text-xs text-hud-cream-mute">Please wait...</span>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-auto p-6">
              <div className="space-y-6">
                {error && (
                  <div className="p-4 bg-hud-plum/10 border border-hud-plum/30 rounded-lg">
                    <p className="text-sm text-hud-plum">{error}</p>
                  </div>
                )}

                <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
                  <h3 className="text-sm font-medium text-hud-cream-soft mb-3">Source Proposal</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-hud-cream-dim">Title:</span>
                      <span className="text-white">{proposal.title}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-hud-cream-dim">Contact:</span>
                      <span className="text-white">
                        {proposal.contact?.first_name} {proposal.contact?.last_name}
                        {proposal.contact?.company && (
                          <span className="text-hud-cream-dim"> ({proposal.contact.company})</span>
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-hud-cream-dim">Value:</span>
                      <span className="text-white">
                        {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: proposal.currency || 'USD',
                          minimumFractionDigits: 0,
                        }).format(proposal.total_value || 0)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-hud-cream-dim">Status:</span>
                      <span className="text-white capitalize">{proposal.status}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-3">
                    Contract Type
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {CONTRACT_TYPE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => setContractType(option.value)}
                        className={`text-left p-3 rounded-lg border transition-all ${
                          contractType === option.value
                            ? 'border-hud-gold bg-hud-gold/10 ring-1 ring-hud-gold/30'
                            : 'border-hud-bg-elev bg-hud-bg-card/50 hover:border-hud-cream-mute'
                        }`}
                      >
                        <span className={`text-sm font-medium ${contractType === option.value ? 'text-hud-gold-soft' : 'text-white'}`}>
                          {option.label}
                        </span>
                        <p className="text-xs text-hud-cream-dim mt-1">{option.description}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                    <p className="text-xs text-hud-cream-mute mt-1">Default: upon signing</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                      <MapPin className="w-4 h-4 inline mr-1" />
                      Governing Law State
                    </label>
                    <input
                      type="text"
                      value={governingLawState}
                      onChange={(e) => setGoverningLawState(e.target.value)}
                      placeholder="e.g. California"
                      className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                    <MessageSquare className="w-4 h-4 inline mr-1" />
                    Custom Instructions for AI
                  </label>
                  <textarea
                    value={customInstructions}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                    rows={3}
                    placeholder="Any specific terms, clauses, or requirements you want included..."
                    className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50 resize-none"
                  />
                </div>

                <MeetingContextPicker
                  contactId={proposal.contact_id}
                  selectedIds={selectedMeetings}
                  onToggle={(meetingId) =>
                    setSelectedMeetings((prev) =>
                      prev.includes(meetingId)
                        ? prev.filter((id) => id !== meetingId)
                        : [...prev, meetingId]
                    )
                  }
                  title="Ground the contract in meetings"
                />

                <div className="p-4 bg-hud-bg-card/50 border border-hud-bg-elev rounded-lg">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={generateWithAI}
                      onChange={(e) => setGenerateWithAI(e.target.checked)}
                      className="mt-0.5 w-5 h-5 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold/50"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-hud-gold-soft" />
                        <span className="text-white font-medium">Generate sections with AI</span>
                      </div>
                      <p className="text-sm text-hud-cream-dim mt-1">
                        AI will draft all 12 contract sections using the proposal data, including plain-language annotations for each clause
                      </p>
                    </div>
                  </label>
                </div>

                <div className="p-4 bg-hud-rust/10 border border-hud-rust/30 rounded-lg">
                  <div className="flex items-start gap-2">
                    <FileText className="w-5 h-5 text-hud-rust flex-shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-sm font-medium text-hud-rust mb-1">Legal Disclaimer</h4>
                      <p className="text-sm text-hud-cream-soft">
                        Generated contracts are templates for informational purposes only. All contracts must be reviewed by a qualified attorney before signing.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end gap-3">
              <button
                onClick={onClose}
                disabled={isConverting}
                className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConvert}
                disabled={isConverting}
                className="flex items-center gap-2 px-5 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg transition-colors font-medium"
              >
                {isConverting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Scale className="w-4 h-4" />
                    Create Contract
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div></Portal>
  );
}
