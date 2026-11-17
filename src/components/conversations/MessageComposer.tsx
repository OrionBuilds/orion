import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Bot, Check } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspaceProvider } from '../../hooks/useWorkspaceProvider';
import { defaultFromConnectionId, fromConnectionIdForSend, type ThreadMailbox } from '../../lib/microsoftAccounts';
import { defaultFromConnectionId as defaultGoogleFromConnectionId, fromConnectionIdForSend as googleFromConnectionIdForSend } from '../../lib/googleAccounts';
import { AskAIModal } from './AskAIModal';
import { SnippetPicker } from './SnippetPicker';
import { createGmailDraft, updateGmailDraft, deleteGmailDraft, getGmailConnectionStatus } from '../../services/gmailApi';
// getConnectionStatus returns the user's Microsoft 365 connection (used for the Outlook send rail).
import { getConnectionStatus as getMicrosoftConnection } from '../../services/googleDrive';
import { getEmailDefaults } from '../../services/emailDefaults';
import { uploadEmailAttachment, type EmailAttachment } from '../../services/emailAttachments';
import { ComposerTabBar } from './composer/ComposerTabBar';
import { EmailComposerContent } from './composer/EmailComposerContent';
import { SMSComposerContent } from './composer/SMSComposerContent';
import type { SendVia } from './composer/EmailSenderSelect';
import { InternalCommentContent } from './composer/InternalCommentContent';
import type { ComposerTab } from './composer/ComposerTabBar';
import type { MessageChannel, Contact, Conversation } from '../../types';
import { resolveAllowedFromNumbers, pickDefaultFromNumber, type TwilioNumber } from '../../services/twilioNumbers';
import { uploadMessageMedia } from '../../services/sendSms';
import { reportBackgroundError } from '../../lib/errors';

interface EmailRecipient {
  email: string;
  name: string;
  contactId?: string;
}

interface MessageComposerProps {
  onSend: (body: string, subject?: string, metadata?: Record<string, unknown>) => Promise<void>;
  onSendInternalComment?: (body: string, mentions: string[]) => Promise<void>;
  sending: boolean;
  disabled: boolean;
  availableChannels: { channel: MessageChannel; identifier: string }[];
  selectedChannel: MessageChannel;
  onChannelChange: (channel: MessageChannel) => void;
  showSubject: boolean;
  contact?: Contact;
  conversation?: Conversation;
  gmailConnected?: boolean;
  fromNumbers?: TwilioNumber[];
  /** Last SMS message in the thread, used to default the From picker to the number the thread is on. */
  lastSmsMeta?: { direction?: string; from_number?: string; to_number?: string };
  /** The Microsoft mailbox the thread's last Outlook message arrived on; a reply defaults to it. */
  threadMailbox?: ThreadMailbox | null;
  /** The Gmail mailbox the thread's last Gmail message arrived on; a reply defaults to it. */
  threadGoogleMailbox?: ThreadMailbox | null;
}

export function MessageComposer({
  onSend,
  onSendInternalComment,
  sending,
  disabled,
  availableChannels,
  selectedChannel,
  onChannelChange,
  contact,
  conversation,
  gmailConnected = false,
  fromNumbers = [],
  lastSmsMeta,
  threadMailbox,
  threadGoogleMailbox,
}: MessageComposerProps) {
  const { user, hasPermission, isFeatureEnabled } = useAuth();
  const { accounts: workspaceAccounts } = useWorkspaceProvider();
  const msAccounts = workspaceAccounts.microsoft;
  // Outlook "From" account: an explicit pick for this thread, else the thread's mailbox, else primary.
  const [pickedMsConnection, setPickedMsConnection] = useState<string | null>(null);
  const msConnectionId = useMemo(() => {
    if (pickedMsConnection && msAccounts.some((a) => a.id === pickedMsConnection)) return pickedMsConnection;
    return defaultFromConnectionId(msAccounts, threadMailbox);
  }, [pickedMsConnection, msAccounts, threadMailbox]);
  // Gmail "From" account (2+ Google accounts): an explicit pick, else the thread's mailbox, else primary.
  const googleAccounts = workspaceAccounts.google;
  const [pickedGoogleConnection, setPickedGoogleConnection] = useState<string | null>(null);
  const googleConnectionId = useMemo(() => {
    if (pickedGoogleConnection && googleAccounts.some((a) => a.id === pickedGoogleConnection)) return pickedGoogleConnection;
    return defaultGoogleFromConnectionId(googleAccounts, threadGoogleMailbox);
  }, [pickedGoogleConnection, googleAccounts, threadGoogleMailbox]);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showAIModal, setShowAIModal] = useState(false);
  const [showSnippetPicker, setShowSnippetPicker] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const [ccRecipients, setCcRecipients] = useState<EmailRecipient[]>([]);
  const [bccRecipients, setBccRecipients] = useState<EmailRecipient[]>([]);
  const [internalMentions, setInternalMentions] = useState<string[]>([]);
  const [uploading] = useState(false);
  const [sendVia, setSendVia] = useState<SendVia>(gmailConnected ? 'gmail' : 'resend');
  const [gmailAddress, setGmailAddress] = useState<string | null>(null);
  const [microsoftConnected, setMicrosoftConnected] = useState(false);
  const [microsoftAddress, setMicrosoftAddress] = useState<string | null>(null);
  const [sendgridSender, setSendgridSender] = useState<{ name: string; email: string }>({ name: '', email: '' });
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [selectedFromNumber, setSelectedFromNumber] = useState<string>('');
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const explicitFromRef = useRef(false);

  const handleAttachFile = useCallback(async (file: File) => {
    if (!user?.organization_id) return;
    setUploadingAttachment(true);
    try {
      const att = await uploadEmailAttachment(file, user.organization_id);
      setAttachments((prev) => [...prev, att]);
    } catch (err) {
      console.error('Attachment upload failed:', err);
    } finally {
      setUploadingAttachment(false);
    }
  }, [user?.organization_id]);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canUseAI = hasPermission('ai_agents.run') && isFeatureEnabled('ai_agents');
  const canUseSnippets = hasPermission('snippets.view') && isFeatureEnabled('snippets');

  const hasEmail = availableChannels.some((c) => c.channel === 'email');
  const hasSms = availableChannels.some((c) => c.channel === 'sms');
  const smsChannel = availableChannels.find((c) => c.channel === 'sms');

  // Numbers this user may send SMS from (admins see all active SMS numbers).
  const isAdmin = hasPermission('conversations.assign');
  const allowedNumbers = useMemo(
    () => (user?.id ? resolveAllowedFromNumbers(fromNumbers, user.id, isAdmin) : []),
    [fromNumbers, user?.id, isAdmin],
  );
  // The number this thread is already on: the org number the contact texted
  // (inbound To) or the number we last sent from (outbound From).
  const threadNumber = lastSmsMeta
    ? lastSmsMeta.direction === 'inbound'
      ? lastSmsMeta.to_number
      : lastSmsMeta.from_number
    : undefined;

  const [activeTab, setActiveTab] = useState<ComposerTab>(() => {
    if (selectedChannel === 'sms' && hasSms) return 'sms';
    if (hasEmail) return 'email';
    if (hasSms) return 'sms';
    return 'internal_comment';
  });

  useEffect(() => {
    if (selectedChannel === 'email' && hasEmail) setActiveTab('email');
    else if (selectedChannel === 'sms' && hasSms) setActiveTab('sms');
  }, [selectedChannel, hasEmail, hasSms]);

  // Reset the "user explicitly picked a number" flag when switching threads.
  useEffect(() => {
    explicitFromRef.current = false;
    setPickedMsConnection(null);
  }, [conversation?.id]);

  // Default the From picker: keep an explicit in-thread choice, else default to
  // the thread's number / the user's default / their first allowed number.
  useEffect(() => {
    setSelectedFromNumber((prev) => {
      if (explicitFromRef.current && prev && allowedNumbers.some((n) => n.phone_number === prev)) {
        return prev;
      }
      return pickDefaultFromNumber(allowedNumbers, threadNumber);
    });
  }, [allowedNumbers, threadNumber, conversation?.id]);

  const handleFromNumberChange = (num: string) => {
    explicitFromRef.current = true;
    setSelectedFromNumber(num);
  };

  const isGmailEmail = gmailConnected && activeTab === 'email' && sendVia === 'gmail';
  // Undefined for single-account users, so their requests carry nothing new.
  const googleSendId = googleFromConnectionIdForSend(googleAccounts, googleConnectionId);

  // Keep the chosen rail in sync with connected mailboxes, and load sender labels.
  useEffect(() => {
    let cancelled = false;
    if (gmailConnected && user?.id) {
      getGmailConnectionStatus(user.id)
        .then((s) => !cancelled && setGmailAddress(s.email || user.email || null))
        .catch(() => !cancelled && setGmailAddress(user.email || null));
    } else {
      setGmailAddress(null);
    }
    // Detect the Microsoft connection for the Outlook rail.
    if (user?.id) {
      getMicrosoftConnection(user.id)
        .then((s) => {
          if (cancelled) return;
          setMicrosoftConnected(s.connected);
          setMicrosoftAddress(s.email);
          // Prefer the user's own mailbox; Gmail wins if both, else Outlook, else org Resend.
          setSendVia(gmailConnected ? 'gmail' : s.connected ? 'outlook' : 'resend');
        })
        .catch(() => { if (!cancelled) setSendVia(gmailConnected ? 'gmail' : 'resend'); });
    } else {
      setSendVia(gmailConnected ? 'gmail' : 'resend');
    }
    return () => { cancelled = true; };
  }, [gmailConnected, user?.id, user?.email]);

  useEffect(() => {
    if (!user?.organization_id) return;
    getEmailDefaults(user.organization_id)
      .then((defaults) => {
        setSendgridSender({
          name: defaults?.default_from_address?.display_name || user.name || '',
          email: defaults?.default_from_address?.email || user.email || '',
        });
      })
      .catch(reportBackgroundError('MessageComposer.getEmailDefaults'));
  }, [user?.organization_id, user?.name, user?.email]);

  const saveDraftToGmail = useCallback(async (draftBody: string, draftSubject: string) => {
    if (!isGmailEmail || !draftBody.trim()) return;
    const channelConfig = availableChannels.find((c) => c.channel === 'email');
    if (!channelConfig) return;

    try {
      if (draftId) {
        await updateGmailDraft({
          connectionId: googleSendId,
          draftId,
          to: channelConfig.identifier,
          subject: draftSubject || undefined,
          htmlBody: draftBody,
        });
      } else {
        const result = await createGmailDraft({
          connectionId: googleSendId,
          to: channelConfig.identifier,
          subject: draftSubject || undefined,
          htmlBody: draftBody,
        });
        if (result?.draftId) {
          setDraftId(result.draftId);
        }
      }
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save Gmail draft:', err);
    }
  }, [isGmailEmail, draftId, availableChannels, googleSendId]);

  useEffect(() => {
    if (!isGmailEmail || !body.trim()) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      saveDraftToGmail(body, subject);
    }, 30000);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [body, subject, isGmailEmail, saveDraftToGmail]);

  useEffect(() => {
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setDraftId(null);
    setDraftSaved(false);
  }, [conversation?.id]);

  // A Gmail draft lives in one mailbox: switching the From account starts a new draft.
  useEffect(() => {
    setDraftId(null);
  }, [googleSendId]);

  const handleTabChange = (tab: ComposerTab) => {
    setActiveTab(tab);
    if (tab === 'email' && hasEmail) onChannelChange('email');
    if (tab === 'sms' && hasSms) onChannelChange('sms');
    setMediaError(null);
  };

  const handleSubmit = async () => {
    const trimmed = body.trim();
    const isSms = activeTab === 'sms';
    const hasContent = isSms ? trimmed.length > 0 || mediaFiles.length > 0 : trimmed.length > 0;
    if (!hasContent || sending || disabled || uploading || uploadingMedia) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);

    try {
      if (activeTab === 'internal_comment') {
        if (onSendInternalComment) {
          await onSendInternalComment(trimmed, internalMentions);
        }
      } else {
        const metadata: Record<string, unknown> = {};

        if (activeTab === 'email') {
          metadata.send_via = sendVia;
          if (sendVia === 'outlook') {
            const fromConnectionId = fromConnectionIdForSend(msAccounts, msConnectionId);
            if (fromConnectionId) metadata.from_connection_id = fromConnectionId;
          }
          if (sendVia === 'gmail' && googleSendId) metadata.from_connection_id = googleSendId;
          if (ccRecipients.length > 0) {
            metadata.cc = ccRecipients.map((r) => r.email).join(', ');
          }
          if (bccRecipients.length > 0) {
            metadata.bcc = bccRecipients.map((r) => r.email).join(', ');
          }
          if (attachments.length > 0) {
            metadata.attachments = attachments;
          }
        }

        if (activeTab === 'sms') {
          if (!selectedFromNumber) return; // no assigned number → blocked
          metadata.from_number = selectedFromNumber;
          if (mediaFiles.length > 0 && user?.organization_id) {
            setUploadingMedia(true);
            try {
              const urls: string[] = [];
              for (const f of mediaFiles) {
                urls.push(await uploadMessageMedia(f, user.organization_id));
              }
              metadata.media_urls = urls;
            } finally {
              setUploadingMedia(false);
            }
          }
        }

        await onSend(
          trimmed,
          activeTab === 'email' ? subject.trim() : undefined,
          Object.keys(metadata).length > 0 ? metadata : undefined
        );

        if (draftId) {
          deleteGmailDraft(draftId, googleSendId).catch(reportBackgroundError('MessageComposer.deleteGmailDraft'));
          setDraftId(null);
        }
      }

      setBody('');
      setSubject('');
      setCcRecipients([]);
      setBccRecipients([]);
      setInternalMentions([]);
      setAttachments([]);
      setMediaFiles([]);
      setMediaError(null);
      setDraftSaved(false);
    } catch {
      // Keep input fields intact for retry
    }
  };

  const handleClear = () => {
    setBody('');
    setSubject('');
    setCcRecipients([]);
    setBccRecipients([]);
    setInternalMentions([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape' && showSnippetPicker) {
      setShowSnippetPicker(false);
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 's') {
      e.preventDefault();
      if (canUseSnippets) setShowSnippetPicker(true);
    }
  };

  const handleSnippetSelect = (content: string) => {
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newBody = body.slice(0, start) + content + body.slice(end);
      setBody(newBody);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + content.length, start + content.length);
      }, 0);
    } else {
      setBody(body + content);
    }
    setShowSnippetPicker(false);
  };

  const emailChannel = availableChannels.find((c) => c.channel === 'email');

  if (disabled) {
    return (
      <div className="p-4 border-t border-hud-bg-elev bg-hud-bg-card">
        <div className="text-center text-hud-cream-mute text-sm py-2">
          This conversation is closed. Reopen it to send messages.
        </div>
      </div>
    );
  }

  if (availableChannels.length === 0 && !onSendInternalComment) {
    return (
      <div className="p-4 border-t border-hud-bg-elev bg-hud-bg-card">
        <div className="text-center text-hud-cream-mute text-sm py-2">
          No contact channels available. Add a phone number or email to the contact to send messages.
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-hud-bg-elev bg-hud-bg-card relative">
      {canUseAI && contact && activeTab !== 'internal_comment' && (
        <div className="absolute -top-9 left-4 z-10">
          <button
            onClick={() => setShowAIModal(true)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-colors shadow-sm"
          >
            <Bot size={14} />
            Ask AI
          </button>
        </div>
      )}

      <ComposerTabBar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        hasEmail={hasEmail}
        hasSms={hasSms}
        expanded={expanded}
        onToggleExpand={() => setExpanded(!expanded)}
      />

      {activeTab === 'email' && emailChannel && (
        <EmailComposerContent
          body={body}
          onBodyChange={setBody}
          subject={subject}
          onSubjectChange={setSubject}
          onSend={handleSubmit}
          onClear={handleClear}
          sending={sending}
          sendDisabled={!body.trim() || sending}
          expanded={expanded}
          fromName={user?.name || ''}
          fromEmail={user?.email || ''}
          sendVia={sendVia}
          onSendViaChange={setSendVia}
          gmailConnected={gmailConnected}
          gmailAddress={gmailAddress}
          microsoftConnected={microsoftConnected}
          microsoftAddress={microsoftAddress}
          microsoftAccounts={msAccounts}
          microsoftConnectionId={msConnectionId}
          onMicrosoftConnectionChange={setPickedMsConnection}
          googleAccounts={googleAccounts}
          googleConnectionId={googleConnectionId}
          onGoogleConnectionChange={setPickedGoogleConnection}
          sendgridName={sendgridSender.name}
          sendgridEmail={sendgridSender.email}
          attachments={attachments}
          onAttachFile={handleAttachFile}
          onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
          canAttach={sendVia === 'gmail'}
          uploadingAttachment={uploadingAttachment}
          toEmail={emailChannel.identifier}
          toName={contact ? `${contact.first_name} ${contact.last_name}`.trim() : ''}
          ccRecipients={ccRecipients}
          onCcChange={setCcRecipients}
          bccRecipients={bccRecipients}
          onBccChange={setBccRecipients}
          onKeyDown={handleKeyDown}
          onSnippetClick={() => setShowSnippetPicker(!showSnippetPicker)}
          canUseSnippets={canUseSnippets}
          textareaRef={textareaRef}
        />
      )}

      {activeTab === 'sms' && smsChannel && (
        allowedNumbers.length === 0 ? (
          <div className="p-4">
            <div className="rounded-lg bg-hud-rust/10 border border-hud-rust/20 p-4 text-sm text-hud-rust/40">
              You don't have a phone number assigned. Ask an admin to assign you a number in
              Phone System settings before you can send SMS.
            </div>
          </div>
        ) : (
          <SMSComposerContent
            body={body}
            onBodyChange={setBody}
            onSend={handleSubmit}
            onClear={handleClear}
            sending={sending || uploadingMedia}
            sendDisabled={(!body.trim() && mediaFiles.length === 0) || sending || uploadingMedia}
            expanded={expanded}
            fromNumbers={allowedNumbers}
            selectedFromNumber={selectedFromNumber}
            onFromNumberChange={handleFromNumberChange}
            toNumber={smsChannel.identifier}
            onKeyDown={handleKeyDown}
            onSnippetClick={() => setShowSnippetPicker(!showSnippetPicker)}
            canUseSnippets={canUseSnippets}
            textareaRef={textareaRef}
            mediaFiles={mediaFiles}
            onMediaChange={setMediaFiles}
            mediaError={mediaError}
            onMediaError={setMediaError}
          />
        )
      )}

      {activeTab === 'internal_comment' && (
        <InternalCommentContent
          body={body}
          onBodyChange={setBody}
          onSend={handleSubmit}
          onClear={handleClear}
          sending={sending}
          sendDisabled={!body.trim() || sending}
          expanded={expanded}
          mentions={internalMentions}
          onMentionsChange={setInternalMentions}
          currentUserId={user?.id}
          orgId={user?.organization_id}
        />
      )}

      {activeTab !== 'internal_comment' && draftSaved && isGmailEmail && (
        <div className="px-4 pb-2 flex items-center gap-1 text-xs text-hud-emerald-dim">
          <Check size={12} />
          Draft saved to Gmail
        </div>
      )}

      {showSnippetPicker && activeTab !== 'internal_comment' && (
        <div className="absolute bottom-full left-4 mb-2 z-50">
          <SnippetPicker
            channel={selectedChannel}
            contact={contact}
            onSelect={handleSnippetSelect}
            onClose={() => setShowSnippetPicker(false)}
          />
        </div>
      )}

      {showAIModal && contact && (
        <AskAIModal
          contact={contact}
          conversation={conversation}
          onClose={() => setShowAIModal(false)}
          onAcceptDraft={(draft, channel, draftSubject) => {
            setBody(draft);
            if (draftSubject) setSubject(draftSubject);
            if (channel === 'email' && hasEmail) {
              handleTabChange('email');
            }
            setShowAIModal(false);
          }}
        />
      )}
    </div>
  );
}
