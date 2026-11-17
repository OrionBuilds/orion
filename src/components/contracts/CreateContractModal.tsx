import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { createStandaloneContract, linkMeetingToContract } from '../../services/contracts';
import { getContacts } from '../../services/contacts';
import { callEdgeFunction } from '../../lib/edgeFunction';
import { MeetingContextPicker } from '../meetings/MeetingContextPicker';
import { InlineCreateContactForm } from '../shared/InlineCreateContactForm';
import type { Contact, ContractType } from '../../types';
import {
  X, Scale, User, Loader2, Search, ChevronRight, Plus, Calendar, MapPin,
  MessageSquare, Sparkles,
} from 'lucide-react';
import { Portal } from '../shared/Portal';

interface CreateContractModalProps {
  onClose: () => void;
  onCreated: () => void;
  preselectedContactId?: string;
}

const CONTRACT_TYPE_OPTIONS: { value: ContractType; label: string; description: string }[] = [
  { value: 'freelance_service', label: 'Freelance Service Agreement', description: 'One-time project with defined deliverables' },
  { value: 'retainer', label: 'Retainer Agreement', description: 'Ongoing monthly engagement' },
  { value: 'partnership', label: 'Partnership Agreement', description: 'Co-venture with shared revenue' },
  { value: 'nda', label: 'Non-Disclosure Agreement', description: 'Pre-engagement confidentiality' },
];

/**
 * Create a contract directly from a contact — no source proposal required.
 * Mirrors CreateProposalModal's contact step, then offers the same client
 * meeting context the proposal builder uses.
 */
export function CreateContractModal({ onClose, onCreated, preselectedContactId }: CreateContractModalProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [step, setStep] = useState<'contact' | 'details' | 'generating'>('contact');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showNewContactForm, setShowNewContactForm] = useState(false);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);

  const [title, setTitle] = useState('');
  const [contractType, setContractType] = useState<ContractType>('freelance_service');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [governingLawState, setGoverningLawState] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedMeetings, setSelectedMeetings] = useState<string[]>([]);
  const [useBuilder, setUseBuilder] = useState(true);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.organization_id) return;
    if (preselectedContactId) {
      getContacts(user.organization_id, { search: '' })
        .then((data) => {
          const c = data.find((x) => x.id === preselectedContactId);
          if (c) handleContactSelect(c);
        })
        .catch(() => { /* fall back to search */ });
    } else {
      searchContacts('');
    }
  }, [user?.organization_id]);

  const searchContacts = async (query: string) => {
    if (!user?.organization_id) return;
    try {
      setIsLoadingContacts(true);
      const data = await getContacts(user.organization_id, { search: query });
      setContacts(data.slice(0, 20));
    } catch (err) {
      console.error('Failed to search contacts:', err);
    } finally {
      setIsLoadingContacts(false);
    }
  };

  const handleContactSelect = (contact: Contact) => {
    setSelectedContact(contact);
    setTitle(`Agreement — ${contact.company || `${contact.first_name} ${contact.last_name}`}`);
    setStep('details');
  };

  const handleSubmit = async () => {
    if (!selectedContact || !user || !title.trim()) return;
    try {
      setIsSubmitting(true);
      setError(null);
      setStep('generating');
      setProgress('Creating contract record...');

      const contract = await createStandaloneContract(user.organization_id, user.id, {
        contact_id: selectedContact.id,
        title: title.trim(),
        contract_type: contractType,
        effective_date: effectiveDate || null,
        governing_law_state: governingLawState || null,
        custom_instructions: customInstructions || null,
      });

      if (selectedMeetings.length > 0) {
        setProgress('Linking meeting context...');
        await Promise.all(
          selectedMeetings.map((id) =>
            linkMeetingToContract(contract.id, id, user.organization_id).catch((e) =>
              console.error('Failed to link meeting:', e)
            )
          )
        );
      }

      // Hand off to the builder, where context, terms and generation live.
      onCreated();
      navigate(useBuilder ? `/contracts/${contract.id}/build` : `/contracts/${contract.id}`);
    } catch (err) {
      console.error('Failed to create contract:', err);
      setError(err instanceof Error ? err.message : 'Failed to create contract.');
      setStep('details');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-hud-bg-elev flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Scale className="w-5 h-5 text-hud-gold-soft" />
              New Contract
            </h2>
            <p className="text-sm text-hud-cream-dim mt-0.5">
              {step === 'contact' ? 'Select the client' : selectedContact
                ? `${selectedContact.first_name} ${selectedContact.last_name}`
                : ''}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-sm text-hud-plum/40">
              {error}
            </div>
          )}

          {step === 'generating' ? (
            <div className="py-16 text-center space-y-3">
              <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin mx-auto" />
              <p className="text-hud-cream-soft">{progress}</p>
            </div>
          ) : step === 'contact' ? (
            <div className="space-y-4">
              {showNewContactForm && user ? (
                <InlineCreateContactForm
                  orgId={user.organization_id}
                  currentUser={user}
                  initialFirstName={contactSearch}
                  onCreated={(contact) => {
                    setContacts((prev) => [contact, ...prev]);
                    setShowNewContactForm(false);
                    handleContactSelect(contact);
                  }}
                  onCancel={() => setShowNewContactForm(false)}
                />
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
                      <input
                        type="text"
                        placeholder="Search contacts..."
                        value={contactSearch}
                        onChange={(e) => {
                          setContactSearch(e.target.value);
                          searchContacts(e.target.value);
                        }}
                        className="w-full pl-10 pr-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                      />
                    </div>
                    <button
                      onClick={() => setShowNewContactForm(true)}
                      className="flex items-center gap-1.5 px-3 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-gold-soft hover:bg-hud-bg-elev text-sm whitespace-nowrap transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      New Contact
                    </button>
                  </div>

                  {isLoadingContacts ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 text-hud-gold-soft animate-spin" />
                    </div>
                  ) : contacts.length === 0 ? (
                    <div className="text-center py-12 text-hud-cream-dim">
                      <User className="w-10 h-10 mx-auto mb-3 opacity-50" />
                      <p>No contacts found</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {contacts.map((contact) => (
                        <button
                          key={contact.id}
                          onClick={() => handleContactSelect(contact)}
                          className="w-full flex items-center justify-between p-4 bg-hud-bg-card/50 hover:bg-hud-bg-card border border-hud-bg-elev rounded-lg transition-colors group"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-hud-bg-elev flex items-center justify-center">
                              <span className="text-sm font-medium text-white">
                                {contact.first_name?.[0]}{contact.last_name?.[0]}
                              </span>
                            </div>
                            <div className="text-left">
                              <p className="text-white font-medium">
                                {contact.first_name} {contact.last_name}
                              </p>
                              <p className="text-sm text-hud-cream-dim">
                                {contact.company || contact.email || 'No company'}
                              </p>
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-hud-cream-mute group-hover:text-hud-gold-soft transition-colors" />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">Contract Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                />
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

              <div className="grid grid-cols-2 gap-4">
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
                    Governing Law (State)
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
                  Custom Instructions for AI
                </label>
                <textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  rows={3}
                  placeholder="Any specific terms, clauses, or requirements..."
                  className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50 resize-none"
                />
              </div>

              <MeetingContextPicker
                contactId={selectedContact?.id ?? null}
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
                    checked={useBuilder}
                    onChange={(e) => setUseBuilder(e.target.checked)}
                    className="mt-0.5 w-5 h-5 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold/50"
                  />
                  <div className="text-sm">
                    <span className="text-white font-medium flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-hud-gold-soft" />
                      Continue in the AI builder
                    </span>
                    <p className="text-hud-cream-dim mt-0.5">
                      Add reference documents, set terms, and generate all sections.
                      Uncheck to create an empty draft you'll write yourself.
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}
        </div>

        {step === 'details' && (
          <div className="px-6 py-4 border-t border-hud-bg-elev flex items-center justify-between">
            <button
              onClick={() => setStep('contact')}
              className="px-4 py-2 text-hud-cream-dim hover:text-white text-sm transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !title.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-hud-gold-deep hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />}
              Create Contract
            </button>
          </div>
        )}
      </div>
    </div></Portal>
  );
}
