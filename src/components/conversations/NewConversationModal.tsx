import { useState, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  X, Search, MessageSquarePlus, Loader2, ArrowLeft,
  Mail, AlertCircle, Plus, ChevronDown, FileText,
  Link2, Image, ClipboardList, Paperclip, MessageSquare, Phone
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { getContacts } from '../../services/contacts';
import { getContactCustomFieldValues } from '../../services/customFields';
import { InlineCreateContactForm } from '../shared/InlineCreateContactForm';
import { findOrCreateConversation } from '../../services/conversations';
import { createMessage } from '../../services/messages';
import {
  listTwilioNumbers, resolveAllowedFromNumbers, pickDefaultFromNumber, type TwilioNumber
} from '../../services/twilioNumbers';
import { sendSms, markSmsFailedIfPending } from '../../services/sendSms';
import { calculateSMSSegments, collectPhoneNumbers, formatPhoneForDisplay } from '../../lib/phoneUtils';
import { getEmailDefaults } from '../../services/emailDefaults';
import { sendGmailEmail, getGmailConnectionStatus } from '../../services/gmailApi';
import { sendConversationEmail } from '../../services/emailSend';
import { sendOutlookEmail } from '../../services/microsoftMail';
import { useWorkspaceProvider } from '../../hooks/useWorkspaceProvider';
import { defaultFromConnectionId, fromConnectionIdForSend, showAccountPicker, type MsAccount } from '../../lib/microsoftAccounts';
import { defaultFromConnectionId as defaultGoogleFromConnectionId, fromConnectionIdForSend as googleFromConnectionIdForSend, type GoogleAccount } from '../../lib/googleAccounts';
import { uploadEmailAttachment, type EmailAttachment } from '../../services/emailAttachments';
import { EmailSenderSelect, type SendVia } from './composer/EmailSenderSelect';
import { SnippetPicker } from './SnippetPicker';
import { FormSurveyPicker, type PickerItem } from './composer/FormSurveyPicker';
import { LinkDialog } from './composer/LinkDialog';
import type { Contact } from '../../types';
import { getInitials, getAvatarColor } from '../../utils/formatters';
import { reportBackgroundError } from '../../lib/errors';
import { Portal } from '../shared/Portal';

type Step = 'contact' | 'compose';
type ComposeChannel = 'email' | 'sms';
type SmsBlockReason = 'loading' | 'no_numbers' | 'not_assigned' | 'no_phone';

const PHONE_SETTINGS_PATH = '/settings/phone-system';

interface NewConversationModalProps {
  onClose: () => void;
  onSelectContact: (contactId: string) => void;
}

export function NewConversationModal({ onClose, onSelectContact }: NewConversationModalProps) {
  const { user, hasPermission, isFeatureEnabled } = useAuth();
  const { showToast } = useToast();
  const canUseSnippets = hasPermission('snippets.view') && isFeatureEnabled('snippets');
  // Same rule as the in-thread composer: admins may send from any active SMS number.
  const isAdmin = hasPermission('conversations.assign');

  const [step, setStep] = useState<Step>('contact');
  const [searchQuery, setSearchQuery] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showNewContactForm, setShowNewContactForm] = useState(false);

  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [sendVia, setSendVia] = useState<SendVia>('resend');
  // Several Microsoft accounts: Outlook becomes a From option per account (a new message defaults to the primary).
  const { accounts: workspaceAccounts } = useWorkspaceProvider();
  const msAccounts = workspaceAccounts.microsoft;
  const [pickedMsConnection, setPickedMsConnection] = useState<string | null>(null);
  const msConnectionId = pickedMsConnection && msAccounts.some((a) => a.id === pickedMsConnection)
    ? pickedMsConnection
    : defaultFromConnectionId(msAccounts);
  // Several Google accounts: Gmail becomes a From option per account (a new message defaults to the primary).
  const googleAccounts = workspaceAccounts.google;
  const [pickedGoogleConnection, setPickedGoogleConnection] = useState<string | null>(null);
  const googleConnectionId = pickedGoogleConnection && googleAccounts.some((a) => a.id === pickedGoogleConnection)
    ? pickedGoogleConnection
    : defaultGoogleFromConnectionId(googleAccounts);
  const [gmailAddress, setGmailAddress] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [ccVisible, setCcVisible] = useState(false);
  const [bccVisible, setBccVisible] = useState(false);
  const [ccValue, setCcValue] = useState('');
  const [bccValue, setBccValue] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const [channel, setChannel] = useState<ComposeChannel>('email');
  const [twilioNumbers, setTwilioNumbers] = useState<TwilioNumber[]>([]);
  const [numbersLoaded, setNumbersLoaded] = useState(false);
  const [contactPhones, setContactPhones] = useState<string[]>([]);
  const [toNumber, setToNumber] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [smsBody, setSmsBody] = useState('');

  // Every active SMS number the org has connected vs. the ones this user may send from.
  const orgSmsNumbers = useMemo(
    () => (user?.id ? resolveAllowedFromNumbers(twilioNumbers, user.id, true) : []),
    [twilioNumbers, user?.id],
  );
  const allowedNumbers = useMemo(
    () => (user?.id ? resolveAllowedFromNumbers(twilioNumbers, user.id, isAdmin) : []),
    [twilioNumbers, user?.id, isAdmin],
  );

  const smsBlockReason: SmsBlockReason | null =
    !numbersLoaded ? 'loading'
      : orgSmsNumbers.length === 0 ? 'no_numbers'
        : allowedNumbers.length === 0 ? 'not_assigned'
          : contactPhones.length === 0 ? 'no_phone'
            : null;
  // Fall back to email when SMS was picked/defaulted but turns out to be unavailable.
  const activeChannel: ComposeChannel =
    channel === 'sms' && smsBlockReason !== null && smsBlockReason !== 'loading' ? 'email' : channel;

  const handleAttachFile = async (file: File) => {
    if (!user?.organization_id) return;
    setUploadingAttachment(true);
    try {
      const att = await uploadEmailAttachment(file, user.organization_id);
      setAttachments((prev) => [...prev, att]);
    } catch {
      setSendError('Attachment upload failed.');
    } finally {
      setUploadingAttachment(false);
    }
  };

  useEffect(() => {
    async function loadContacts() {
      if (!user?.organization_id) return;
      try {
        setLoading(true);
        const data = await getContacts(user.organization_id, {
          status: 'active',
          sortBy: 'name',
          sortOrder: 'asc'
        });
        setContacts(data);
        setFilteredContacts(data);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    loadContacts();
  }, [user?.organization_id]);

  useEffect(() => {
    if (!user?.organization_id) return;
    setFromName(user.name || '');
    setFromEmail(user.email || '');
    getEmailDefaults(user.organization_id).then(defaults => {
      if (defaults?.default_from_address?.email) {
        setFromEmail(defaults.default_from_address.email);
      }
      if (defaults?.default_from_address?.display_name) {
        setFromName(defaults.default_from_address.display_name);
      }
    }).catch(reportBackgroundError('NewConversationModal.getEmailDefaults'));

    // Per-user Gmail: default to the user's Gmail when connected, and fetch the
    // connected address for the sender label.
    if (user.gmail_connected) {
      setSendVia('gmail');
      getGmailConnectionStatus(user.id)
        .then((status) => setGmailAddress(status.email || user.email || null))
        .catch(() => setGmailAddress(user.email || null));
    } else {
      setSendVia('resend');
      setGmailAddress(null);
    }
  }, [user]);

  useEffect(() => {
    if (!user?.organization_id) return;
    listTwilioNumbers(user.organization_id)
      .then(setTwilioNumbers)
      .catch(reportBackgroundError('NewConversationModal.listTwilioNumbers'))
      .finally(() => setNumbersLoaded(true));
  }, [user?.organization_id]);

  // Default From: keep a still-valid choice, else the number assigned to this
  // user, else the org's default SMS number, else the first allowed one.
  useEffect(() => {
    const mine = allowedNumbers.find((n) => n.sms_route === 'user' && n.assigned_user_id === user?.id);
    setFromNumber((prev) =>
      prev && allowedNumbers.some((n) => n.phone_number === prev)
        ? prev
        : pickDefaultFromNumber(allowedNumbers, mine?.phone_number),
    );
  }, [allowedNumbers, user?.id]);

  // The selected contact's phone numbers: the primary phone plus any phone-type
  // custom fields. Contacts with a phone but no email default to SMS.
  useEffect(() => {
    if (!selectedContact) {
      setContactPhones([]);
      setToNumber('');
      return;
    }
    let cancelled = false;
    const apply = (phones: string[]) => {
      if (cancelled) return;
      setContactPhones(phones);
      setToNumber((prev) => (prev && phones.includes(prev) ? prev : phones[0] ?? ''));
      if (!selectedContact.email && phones.length > 0) setChannel('sms');
    };
    apply(collectPhoneNumbers([selectedContact.phone]));
    getContactCustomFieldValues(selectedContact.id)
      .then((values) => {
        const extra = values
          .filter((v) => v.custom_field?.field_type === 'phone' && typeof v.value === 'string')
          .map((v) => v.value as string);
        if (extra.length > 0) apply(collectPhoneNumbers([selectedContact.phone, ...extra]));
      })
      .catch(reportBackgroundError('NewConversationModal.getContactCustomFieldValues'));
    return () => { cancelled = true; };
  }, [selectedContact]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredContacts(contacts);
      return;
    }
    const q = searchQuery.toLowerCase();
    setFilteredContacts(contacts.filter(c => {
      const name = `${c.first_name} ${c.last_name}`.toLowerCase();
      return name.includes(q) || c.email?.toLowerCase().includes(q) ||
        c.phone?.includes(q) || c.company?.toLowerCase().includes(q);
    }));
  }, [searchQuery, contacts]);

  const handleContactSelect = (contact: Contact) => {
    setSelectedContact(contact);
    setChannel(contact.email || !contact.phone ? 'email' : 'sms');
    setStep('compose');
  };

  const wordCount = messageBody.trim() ? messageBody.trim().split(/\s+/).length : 0;
  const canSend = !!selectedContact?.email && subject.trim().length > 0 && messageBody.trim().length > 0 && !sending;
  const canSendSms = smsBlockReason === null && !!fromNumber && !!toNumber && smsBody.trim().length > 0 && !sending;

  // Same path as an SMS reply in the thread (MessageThread.handleSendMessage):
  // insert the outbound row with from/to numbers, then dispatch it through
  // sendSms -> twilio-sms-send, which updates that row in place.
  const handleSendSms = async () => {
    if (!selectedContact || !user?.organization_id || !canSendSms) return;
    setSending(true);
    setSendError(null);
    try {
      const conversation = await findOrCreateConversation(
        user.organization_id,
        selectedContact.id,
        user.department_id,
        'sms'
      );

      const message = await createMessage(
        user.organization_id,
        conversation.id,
        selectedContact.id,
        'sms',
        'outbound',
        smsBody.trim(),
        { from_number: fromNumber, to_number: toNumber }
      );

      try {
        await sendSms(message.id);
      } catch (err) {
        // The message row already exists, so open the conversation where it shows
        // as failed with Retry, rather than letting a re-send create a duplicate.
        const errorMsg = err instanceof Error ? err.message : 'Failed to send SMS';
        await markSmsFailedIfPending(message.id, errorMsg)
          .catch(reportBackgroundError('NewConversationModal.markSmsFailedIfPending'));
        showToast('warning', 'SMS not sent', `${errorMsg}. You can retry it from the conversation.`);
      }

      onSelectContact(selectedContact.id);
      onClose();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
    if (!selectedContact || !user?.organization_id || !selectedContact.email) return;
    setSending(true);
    setSendError(null);
    try {
      const conversation = await findOrCreateConversation(
        user.organization_id,
        selectedContact.id,
        user.department_id
      );

      if (sendVia === 'outlook' && showAccountPicker(msAccounts)) {
        await sendOutlookEmail({
          to: selectedContact.email,
          subject: subject.trim() || 'New message',
          htmlBody: messageBody.trim(),
          cc: ccValue || undefined,
          bcc: bccValue || undefined,
          fromConnectionId: fromConnectionIdForSend(msAccounts, msConnectionId),
        });
      } else if (sendVia === 'gmail') {
        // Send as the logged-in user's connected Gmail; the gmail-api edge
        // function records the message on the conversation itself.
        await sendGmailEmail({
          to: selectedContact.email,
          subject: subject.trim() || 'New message',
          htmlBody: messageBody.trim(),
          conversationId: conversation.id,
          contactId: selectedContact.id,
          cc: ccValue || undefined,
          bcc: bccValue || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          fromConnectionId: googleFromConnectionIdForSend(googleAccounts, googleConnectionId),
        });
      } else {
        const message = await createMessage(
          user.organization_id,
          conversation.id,
          selectedContact.id,
          'email',
          'outbound',
          messageBody.trim(),
          {
            from_name: fromName,
            from_email: fromEmail,
            to_email: selectedContact.email,
            cc: ccValue || undefined,
            bcc: bccValue || undefined,
          },
          subject.trim() || 'New message'
        );
        // Org Resend sender with the Email Services Defaults (the row was previously left
        // 'pending' with nothing sending it).
        const sent = await sendConversationEmail(message.id);
        if (!sent.success) throw new Error(sent.error || 'Failed to send email');
      }

      onSelectContact(selectedContact.id);
      onClose();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleClear = () => {
    setSubject('');
    setMessageBody('');
    setCcValue('');
    setBccValue('');
    setCcVisible(false);
    setBccVisible(false);
    setAttachments([]);
  };

  return (
    <Portal><div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-card rounded-xl shadow-2xl w-full max-w-2xl flex flex-col border border-hud-bg-elev"
        style={{ maxHeight: '90vh' }}>

        <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev flex-shrink-0">
          <div className="flex items-center gap-2">
            {step === 'compose' && (
              <button
                onClick={() => { setStep('contact'); setSelectedContact(null); setSendError(null); setSubject(''); setMessageBody(''); setSmsBody(''); }}
                className="p-1 hover:bg-hud-bg-elev rounded transition-colors mr-1"
              >
                <ArrowLeft size={18} className="text-hud-cream-dim" />
              </button>
            )}
            <MessageSquarePlus className="w-5 h-5 text-hud-gold-soft" />
            <h2 className="text-lg font-semibold text-white">
              {step === 'contact' ? 'New Conversation' : 'Compose Message'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-hud-bg-elev rounded transition-colors">
            <X size={20} className="text-hud-cream-dim" />
          </button>
        </div>

        {step === 'contact' ? (
          <>
            {showNewContactForm && user ? (
              <div className="flex-1 overflow-y-auto p-5">
                <InlineCreateContactForm
                  orgId={user.organization_id}
                  currentUser={user}
                  initialFirstName={searchQuery}
                  onCreated={(contact) => {
                    setContacts((prev) => [contact, ...prev]);
                    setFilteredContacts((prev) => [contact, ...prev]);
                    setShowNewContactForm(false);
                    handleContactSelect(contact);
                  }}
                  onCancel={() => setShowNewContactForm(false)}
                />
              </div>
            ) : (
              <>
                <div className="px-5 py-3 border-b border-hud-bg-elev flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-dim" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search contacts by name, email, phone, or company..."
                        className="w-full pl-9 pr-4 py-2.5 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                        autoFocus
                      />
                    </div>
                    <button
                      onClick={() => setShowNewContactForm(true)}
                      className="flex items-center gap-1.5 px-3 py-2.5 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-hud-gold-soft hover:bg-hud-bg-elev text-sm whitespace-nowrap transition-colors"
                    >
                      <Plus size={15} />
                      New
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4">
                  {loading ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 className="w-7 h-7 text-hud-gold-soft animate-spin" />
                    </div>
                  ) : filteredContacts.length === 0 ? (
                    <div className="text-center py-16">
                      <MessageSquarePlus className="w-10 h-10 text-hud-cream-mute mx-auto mb-3" />
                      <p className="text-hud-cream-dim text-sm mb-4">
                        {contacts.length === 0 ? 'No contacts found.' : 'No contacts match your search.'}
                      </p>
                      <button
                        onClick={() => setShowNewContactForm(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg text-sm hover:bg-hud-gold-deep transition-colors mx-auto"
                      >
                        <Plus size={15} />
                        Create New Contact
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredContacts.map(contact => (
                        <ContactItem key={contact.id} contact={contact} onSelect={handleContactSelect} />
                      ))}
                    </div>
                  )}
                </div>

                <div className="px-5 py-3 border-t border-hud-bg-elev flex justify-end flex-shrink-0">
                  <button onClick={onClose} className="px-4 py-2 text-sm text-hud-cream-dim hover:text-white transition-colors">
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        ) : selectedContact ? (
          <>
          <ChannelPicker
            channel={activeChannel}
            onChange={(c) => { setChannel(c); setSendError(null); }}
            smsBlockReason={smsBlockReason}
            onNavigateAway={onClose}
          />
          {activeChannel === 'sms' && smsBlockReason === 'loading' ? (
            <div className="flex-1 flex items-center justify-center py-16">
              <Loader2 className="w-7 h-7 text-hud-gold-soft animate-spin" />
            </div>
          ) : activeChannel === 'sms' ? (
            <SmsComposeStep
              contact={selectedContact}
              fromNumbers={allowedNumbers}
              fromNumber={fromNumber}
              onFromNumberChange={setFromNumber}
              toNumbers={contactPhones}
              toNumber={toNumber}
              onToNumberChange={setToNumber}
              body={smsBody}
              onBodyChange={setSmsBody}
              canSend={canSendSms}
              sending={sending}
              sendError={sendError}
              onSend={handleSendSms}
              onClear={() => setSmsBody('')}
              canUseSnippets={canUseSnippets}
            />
          ) : (
          <EmailComposeStep
            contact={selectedContact}
            fromName={fromName}
            fromEmail={fromEmail}
            sendVia={sendVia}
            onSendViaChange={setSendVia}
            gmailConnected={!!user?.gmail_connected}
            gmailAddress={gmailAddress}
            microsoftAccounts={msAccounts}
            microsoftConnectionId={msConnectionId}
            onMicrosoftConnectionChange={setPickedMsConnection}
            googleAccounts={googleAccounts}
            googleConnectionId={googleConnectionId}
            onGoogleConnectionChange={setPickedGoogleConnection}
            subject={subject}
            onSubjectChange={setSubject}
            messageBody={messageBody}
            onMessageBodyChange={setMessageBody}
            ccVisible={ccVisible}
            bccVisible={bccVisible}
            ccValue={ccValue}
            bccValue={bccValue}
            onCcToggle={() => setCcVisible(v => !v)}
            onBccToggle={() => setBccVisible(v => !v)}
            onCcChange={setCcValue}
            onBccChange={setBccValue}
            wordCount={wordCount}
            canSend={canSend}
            sending={sending}
            sendError={sendError}
            onSend={handleSend}
            onClear={handleClear}
            onClose={onClose}
            attachments={attachments}
            onAttachFile={handleAttachFile}
            onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
            uploadingAttachment={uploadingAttachment}
            canAttach={sendVia === 'gmail'}
            canUseSnippets={canUseSnippets}
          />
          )}
          </>
        ) : null}
      </div>
    </div></Portal>
  );
}

interface ChannelPickerProps {
  channel: ComposeChannel;
  onChange: (channel: ComposeChannel) => void;
  smsBlockReason: SmsBlockReason | null;
  onNavigateAway: () => void;
}

function ChannelPicker({ channel, onChange, smsBlockReason, onNavigateAway }: ChannelPickerProps) {
  const smsDisabled = smsBlockReason !== null;
  const settingsLink = (
    <Link to={PHONE_SETTINGS_PATH} onClick={onNavigateAway} className="text-hud-gold-soft hover:underline">
      Phone System settings
    </Link>
  );
  const hint: React.ReactNode =
    smsBlockReason === 'no_numbers' ? <>SMS unavailable: no Twilio number is connected. Connect one in {settingsLink}.</>
      : smsBlockReason === 'not_assigned' ? <>SMS unavailable: you don't have a phone number assigned. Ask an admin to assign you one in {settingsLink}.</>
        : smsBlockReason === 'no_phone' ? 'SMS unavailable: this contact has no phone number.'
          : null;

  const tabClass = (active: boolean, disabled: boolean) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
      active
        ? 'bg-hud-gold-deep text-white'
        : disabled
          ? 'text-hud-cream-mute cursor-not-allowed'
          : 'text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev'
    }`;

  return (
    <div className="flex items-center gap-3 px-5 py-2.5 border-b border-hud-bg-elev flex-shrink-0 flex-wrap">
      <div className="flex items-center gap-1 bg-hud-bg-mid border border-hud-cream-mute rounded-lg p-0.5">
        <button onClick={() => onChange('email')} className={tabClass(channel === 'email', false)}>
          <Mail size={14} />
          Email
        </button>
        <button
          onClick={() => !smsDisabled && onChange('sms')}
          disabled={smsDisabled}
          title={smsBlockReason === 'loading' ? 'Loading phone numbers…' : undefined}
          className={tabClass(channel === 'sms', smsDisabled)}
        >
          {smsBlockReason === 'loading' ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
          SMS
        </button>
      </div>
      {hint && <p className="text-xs text-hud-cream-mute flex-1 min-w-[200px]">{hint}</p>}
    </div>
  );
}

interface SmsComposeStepProps {
  contact: Contact;
  fromNumbers: TwilioNumber[];
  fromNumber: string;
  onFromNumberChange: (v: string) => void;
  toNumbers: string[];
  toNumber: string;
  onToNumberChange: (v: string) => void;
  body: string;
  onBodyChange: (v: string) => void;
  canSend: boolean;
  sending: boolean;
  sendError: string | null;
  onSend: () => void;
  onClear: () => void;
  canUseSnippets: boolean;
}

function SmsComposeStep({
  contact, fromNumbers, fromNumber, onFromNumberChange, toNumbers, toNumber, onToNumberChange,
  body, onBodyChange, canSend, sending, sendError, onSend, onClear, canUseSnippets
}: SmsComposeStepProps) {
  const fullName = `${contact.first_name} ${contact.last_name}`.trim();
  const initials = getInitials(fullName);
  const avatarColor = getAvatarColor(fullName);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [showSnippetPicker, setShowSnippetPicker] = useState(false);
  const smsInfo = calculateSMSSegments(body);

  const selectClass = 'appearance-none bg-hud-bg-mid border border-hud-cream-mute rounded-lg pl-3 pr-8 py-1.5 text-sm text-white font-medium focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent max-w-[320px] truncate cursor-pointer';

  const insertAtCursor = (snippet: string) => {
    const el = bodyRef.current;
    if (el) {
      const start = el.selectionStart;
      onBodyChange(body.substring(0, start) + snippet + body.substring(el.selectionEnd));
    } else {
      const sep = body.length > 0 && !/\s$/.test(body) ? ' ' : '';
      onBodyChange(body + sep + snippet);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">

        {/* From row — the org's connected Twilio numbers this user may send from */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-hud-bg-elev/60">
          <span className="text-xs text-hud-cream-mute flex-shrink-0 w-10">From:</span>
          <div className="relative min-w-0">
            <select
              value={fromNumber}
              onChange={e => onFromNumberChange(e.target.value)}
              title="Choose which number to text from"
              className={selectClass}
            >
              {fromNumbers.map((n) => (
                <option key={n.id} value={n.phone_number}>
                  {n.friendly_name ? `${n.friendly_name} · ` : ''}{formatPhoneForDisplay(n.phone_number)}{n.is_default_sms ? ' (Default)' : ''}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-hud-cream-dim pointer-events-none" />
          </div>
        </div>

        {/* To row */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-hud-bg-elev/60">
          <span className="text-xs text-hud-cream-mute flex-shrink-0 w-10">To:</span>
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-semibold ${avatarColor} flex-shrink-0`}>
            {initials}
          </div>
          {toNumbers.length > 1 ? (
            <div className="relative min-w-0">
              <select
                value={toNumber}
                onChange={e => onToNumberChange(e.target.value)}
                title="Choose which of the contact's numbers to text"
                className={selectClass}
              >
                {toNumbers.map((p, i) => (
                  <option key={p} value={p}>
                    {formatPhoneForDisplay(p)}{i === 0 && p === contact.phone ? ' (Primary)' : ''}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-hud-cream-dim pointer-events-none" />
            </div>
          ) : (
            <span className="text-sm text-white truncate">
              {fullName ? `${fullName} · ` : ''}{formatPhoneForDisplay(toNumber)}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 px-5 pt-3 pb-2 min-h-[160px]">
          <textarea
            ref={bodyRef}
            value={body}
            onChange={e => onBodyChange(e.target.value)}
            placeholder="Write your text message..."
            className="w-full bg-transparent text-sm text-white placeholder-hud-cream-dim focus:outline-none resize-none min-h-[140px]"
            rows={6}
            autoFocus
          />
        </div>

        {sendError && (
          <div className="mx-5 mb-3 flex items-center gap-2 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
            <AlertCircle size={15} />
            {sendError}
          </div>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className="border-t border-hud-bg-elev px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-1 flex-1">
          {canUseSnippets && (
            <button onClick={() => setShowSnippetPicker(true)} title="Insert snippet" className="p-1.5 rounded text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev transition-colors">
              <FileText size={15} />
            </button>
          )}
        </div>
        <span className="text-xs text-hud-cream-mute flex-shrink-0">
          {body.length} {body.length === 1 ? 'char' : 'chars'} · {body ? smsInfo.segments : 0} {smsInfo.segments === 1 && body ? 'segment' : 'segments'}
        </span>
        <button
          onClick={onClear}
          className="px-3 py-1.5 rounded-lg text-sm text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute border border-hud-cream-mute transition-colors flex-shrink-0"
        >
          Clear
        </button>
        <button
          onClick={onSend}
          disabled={!canSend}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex-shrink-0 ${
            canSend
              ? 'bg-hud-gold-deep hover:bg-hud-gold text-white'
              : 'bg-hud-bg-elev text-hud-cream-mute cursor-not-allowed'
          }`}
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : null}
          {sending ? 'Sending...' : 'Send SMS'}
        </button>
      </div>

      {showSnippetPicker && (
        <SnippetPicker
          channel="sms"
          contact={contact}
          onSelect={(content) => insertAtCursor(content)}
          onClose={() => setShowSnippetPicker(false)}
        />
      )}
    </div>
  );
}

interface EmailComposeStepProps {
  contact: Contact;
  fromName: string;
  fromEmail: string;
  sendVia: SendVia;
  onSendViaChange: (v: SendVia) => void;
  gmailConnected: boolean;
  gmailAddress: string | null;
  microsoftAccounts: MsAccount[];
  microsoftConnectionId: string | null;
  onMicrosoftConnectionChange: (connectionId: string) => void;
  googleAccounts: GoogleAccount[];
  googleConnectionId: string | null;
  onGoogleConnectionChange: (connectionId: string) => void;
  subject: string;
  onSubjectChange: (v: string) => void;
  messageBody: string;
  onMessageBodyChange: (v: string) => void;
  ccVisible: boolean;
  bccVisible: boolean;
  ccValue: string;
  bccValue: string;
  onCcToggle: () => void;
  onBccToggle: () => void;
  onCcChange: (v: string) => void;
  onBccChange: (v: string) => void;
  wordCount: number;
  canSend: boolean;
  sending: boolean;
  sendError: string | null;
  onSend: () => void;
  onClear: () => void;
  onClose: () => void;
  attachments: EmailAttachment[];
  onAttachFile: (file: File) => void;
  onRemoveAttachment: (index: number) => void;
  uploadingAttachment: boolean;
  canAttach: boolean;
  canUseSnippets: boolean;
}

function EmailComposeStep({
  contact, fromName, fromEmail, sendVia, onSendViaChange, gmailConnected, gmailAddress,
  microsoftAccounts, microsoftConnectionId, onMicrosoftConnectionChange,
  googleAccounts, googleConnectionId, onGoogleConnectionChange,
  subject, onSubjectChange,
  messageBody, onMessageBodyChange, ccVisible, bccVisible, ccValue, bccValue,
  onCcToggle, onBccToggle, onCcChange, onBccChange,
  wordCount, canSend, sending, sendError, onSend, onClear, onClose,
  attachments, onAttachFile, onRemoveAttachment, uploadingAttachment, canAttach, canUseSnippets
}: EmailComposeStepProps) {
  const fullName = `${contact.first_name} ${contact.last_name}`.trim();
  const initials = getInitials(fullName);
  const avatarColor = getAvatarColor(fullName);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showSnippetPicker, setShowSnippetPicker] = useState(false);
  const [showFormSurveyPicker, setShowFormSurveyPicker] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkInitialText, setLinkInitialText] = useState('');

  const autoResize = () => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const insertAtCursor = (snippet: string, replaceSelection = false) => {
    const el = bodyRef.current;
    if (el) {
      const start = el.selectionStart;
      const end = replaceSelection ? el.selectionEnd : start;
      onMessageBodyChange(messageBody.substring(0, start) + snippet + messageBody.substring(end));
    } else {
      const sep = messageBody.length > 0 && !/\s$/.test(messageBody) ? ' ' : '';
      onMessageBodyChange(messageBody + sep + snippet);
    }
  };

  const openLinkDialog = () => {
    const el = bodyRef.current;
    setLinkInitialText(el ? messageBody.substring(el.selectionStart, el.selectionEnd) : '');
    setShowLinkDialog(true);
  };

  const handleInsertLink = (url: string, text: string) => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    insertAtCursor(`<a href="${esc(url)}">${esc(text)}</a>`, true);
    setShowLinkDialog(false);
  };

  const handleInsertFormSurvey = (item: PickerItem) => {
    const path = item.kind === 'form' ? 'f' : 's';
    insertAtCursor(`${window.location.origin}/${path}/${item.slug}`, true);
    setShowFormSurveyPicker(false);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) Array.from(files).forEach(onAttachFile);
    e.target.value = '';
  };

  const formatSize = (bytes: number) =>
    bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

  if (!contact.email) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <AlertCircle className="w-10 h-10 text-rose-400 mx-auto mb-3" />
            <p className="text-hud-cream-soft text-sm">This contact has no email address.</p>
            <p className="text-hud-cream-mute text-xs mt-1">Add an email to the contact to start a conversation.</p>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-hud-bg-elev flex justify-end flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-hud-cream-dim hover:text-white transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">

        {/* From row — choose org Resend sender vs the user's connected Gmail */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-hud-bg-elev/60">
          <EmailSenderSelect
            value={sendVia}
            onChange={onSendViaChange}
            gmailConnected={gmailConnected}
            gmailAddress={gmailAddress}
            microsoftConnected={showAccountPicker(microsoftAccounts)}
            microsoftAccounts={microsoftAccounts}
            microsoftConnectionId={microsoftConnectionId}
            onMicrosoftConnectionChange={onMicrosoftConnectionChange}
            googleAccounts={googleAccounts}
            googleConnectionId={googleConnectionId}
            onGoogleConnectionChange={onGoogleConnectionChange}
            sendgridName={fromName}
            sendgridEmail={fromEmail}
          />
        </div>

        {/* To row */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-hud-bg-elev/60">
          <span className="text-xs text-hud-cream-mute flex-shrink-0 w-6">To:</span>
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-semibold ${avatarColor} flex-shrink-0`}>
            {initials}
          </div>
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <span className="text-sm text-white truncate">{contact.email}</span>
            <span className="text-xs text-hud-cream-mute flex-shrink-0">(Primary)</span>
            <ChevronDown size={13} className="text-hud-cream-mute flex-shrink-0" />
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={onCcToggle}
              className={`text-xs font-medium transition-colors ${ccVisible ? 'text-hud-gold-soft' : 'text-hud-cream-dim hover:text-white'}`}
            >
              CC
            </button>
            <button
              onClick={onBccToggle}
              className={`text-xs font-medium transition-colors ${bccVisible ? 'text-hud-gold-soft' : 'text-hud-cream-dim hover:text-white'}`}
            >
              BCC
            </button>
          </div>
        </div>

        {/* CC row */}
        {ccVisible && (
          <div className="flex items-center gap-3 px-5 py-2.5 border-b border-hud-bg-elev/60">
            <span className="text-xs text-hud-cream-mute flex-shrink-0 w-6">CC:</span>
            <input
              type="text"
              value={ccValue}
              onChange={e => onCcChange(e.target.value)}
              placeholder="Add CC recipients..."
              className="flex-1 bg-transparent text-sm text-white placeholder-hud-cream-dim focus:outline-none"
              autoFocus
            />
          </div>
        )}

        {/* BCC row */}
        {bccVisible && (
          <div className="flex items-center gap-3 px-5 py-2.5 border-b border-hud-bg-elev/60">
            <span className="text-xs text-hud-cream-mute flex-shrink-0 w-6">BCC:</span>
            <input
              type="text"
              value={bccValue}
              onChange={e => onBccChange(e.target.value)}
              placeholder="Add BCC recipients..."
              className="flex-1 bg-transparent text-sm text-white placeholder-hud-cream-dim focus:outline-none"
              autoFocus={!ccVisible}
            />
          </div>
        )}

        {/* Subject row */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-hud-bg-elev/60">
          <span className="text-xs text-hud-cream-mute flex-shrink-0 w-12">Subject:</span>
          <input
            type="text"
            value={subject}
            onChange={e => onSubjectChange(e.target.value)}
            placeholder="Enter subject..."
            className="flex-1 bg-transparent text-sm text-white placeholder-hud-cream-dim focus:outline-none"
          />
        </div>

        {/* Body */}
        <div className="flex-1 px-5 pt-3 pb-2 min-h-[160px]">
          <textarea
            ref={bodyRef}
            value={messageBody}
            onChange={e => { onMessageBodyChange(e.target.value); autoResize(); }}
            placeholder="Write your email..."
            className="w-full bg-transparent text-sm text-white placeholder-hud-cream-dim focus:outline-none resize-none min-h-[140px]"
            rows={6}
          />
        </div>

        {sendError && (
          <div className="mx-5 mb-3 flex items-center gap-2 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
            <AlertCircle size={15} />
            {sendError}
          </div>
        )}
      </div>

      {(attachments.length > 0 || uploadingAttachment) && (
        <div className="flex flex-wrap gap-2 px-4 pt-2 border-t border-hud-bg-elev/60">
          {attachments.map((att, i) => (
            <div key={`${att.path}-${i}`} className="flex items-center gap-1.5 bg-hud-bg-elev/60 border border-hud-cream-mute rounded-lg pl-2 pr-1 py-1 text-xs text-hud-cream-soft max-w-[220px]">
              <Paperclip size={12} className="text-hud-cream-dim shrink-0" />
              <span className="truncate">{att.filename}</span>
              <span className="text-hud-cream-mute shrink-0">{formatSize(att.size)}</span>
              <button onClick={() => onRemoveAttachment(i)} className="p-0.5 hover:bg-hud-cream-mute rounded shrink-0" title="Remove attachment">
                <X size={12} className="text-hud-cream-dim" />
              </button>
            </div>
          ))}
          {uploadingAttachment && (
            <div className="flex items-center gap-1.5 bg-hud-bg-elev/60 border border-hud-cream-mute rounded-lg px-2 py-1 text-xs text-hud-cream-dim">
              <Loader2 size={12} className="animate-spin" /> Uploading…
            </div>
          )}
        </div>
      )}

      {/* Bottom toolbar */}
      <div className="border-t border-hud-bg-elev px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-1 flex-1">
          {canUseSnippets && (
            <button onClick={() => setShowSnippetPicker(true)} title="Insert snippet" className="p-1.5 rounded text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev transition-colors">
              <FileText size={15} />
            </button>
          )}
          <button onClick={openLinkDialog} title="Insert link" className="p-1.5 rounded text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev transition-colors">
            <Link2 size={15} />
          </button>
          {canAttach && (
            <button onClick={() => fileInputRef.current?.click()} title="Attach image" className="p-1.5 rounded text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev transition-colors">
              <Image size={15} />
            </button>
          )}
          <button onClick={() => setShowFormSurveyPicker(true)} title="Insert form or survey link" className="p-1.5 rounded text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev transition-colors">
            <ClipboardList size={15} />
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFilePick} />
        </div>
        <span className="text-xs text-hud-cream-mute flex-shrink-0">{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
        <button
          onClick={onClear}
          className="px-3 py-1.5 rounded-lg text-sm text-hud-cream-soft bg-hud-bg-elev hover:bg-hud-cream-mute border border-hud-cream-mute transition-colors flex-shrink-0"
        >
          Clear
        </button>
        <button
          onClick={onSend}
          disabled={!canSend}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex-shrink-0 ${
            canSend
              ? 'bg-hud-gold-deep hover:bg-hud-gold text-white'
              : 'bg-hud-bg-elev text-hud-cream-mute cursor-not-allowed'
          }`}
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : null}
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>

      {showSnippetPicker && (
        <SnippetPicker
          channel="email"
          contact={contact}
          onSelect={(content) => insertAtCursor(content)}
          onClose={() => setShowSnippetPicker(false)}
        />
      )}

      <FormSurveyPicker
        open={showFormSurveyPicker}
        onClose={() => setShowFormSurveyPicker(false)}
        onSelect={handleInsertFormSurvey}
      />

      {showLinkDialog && (
        <LinkDialog
          initialText={linkInitialText}
          onInsert={handleInsertLink}
          onClose={() => setShowLinkDialog(false)}
        />
      )}
    </div>
  );
}

interface ContactItemProps {
  contact: Contact;
  onSelect: (contact: Contact) => void;
}

function ContactItem({ contact, onSelect }: ContactItemProps) {
  const fullName = `${contact.first_name} ${contact.last_name}`.trim();
  const initials = getInitials(fullName);
  const avatarColor = getAvatarColor(fullName);

  return (
    <button
      onClick={() => onSelect(contact)}
      className="w-full p-3 rounded-lg hover:bg-hud-bg-elev transition-colors text-left flex items-center gap-3 group"
    >
      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-medium ${avatarColor} flex-shrink-0`}>
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-white text-sm font-medium group-hover:text-hud-gold-soft transition-colors truncate">
          {fullName}
        </h3>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {contact.company && <span className="text-xs text-hud-cream-dim truncate">{contact.company}</span>}
          {contact.company && contact.email && <span className="text-hud-cream-mute text-xs">•</span>}
          {contact.email && (
            <span className="flex items-center gap-1 text-xs text-hud-cream-mute">
              <Mail size={10} />
              {contact.email}
            </span>
          )}
          {(contact.company || contact.email) && contact.phone && <span className="text-hud-cream-mute text-xs">•</span>}
          {contact.phone && (
            <span className="flex items-center gap-1 text-xs text-hud-cream-mute">
              <Phone size={10} />
              {formatPhoneForDisplay(contact.phone)}
            </span>
          )}
        </div>
      </div>
      <MessageSquarePlus className="w-4 h-4 text-hud-cream-mute group-hover:text-hud-gold-soft transition-colors flex-shrink-0" />
    </button>
  );
}