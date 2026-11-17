import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, AlertTriangle, Bot, MessageSquare, Mail, ChevronDown, PencilLine } from 'lucide-react';
import { useDevice } from '../../contexts/DeviceContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { MessageBubble } from './MessageBubble';
import { MessageComposer } from './MessageComposer';
import { ConversationHeader } from './ConversationHeader';
import { EmailThreadDrawer } from './EmailThreadDrawer';
import { CreateTaskModal } from '../tasks/CreateTaskModal';
import { usePermission } from '../../hooks/usePermission';
import { getRecentMessages, createMessage, getInternalComments } from '../../services/messages';
import { syncMentionsForSource } from '../../services/entityMentions';
import { getInboxEvents } from '../../services/inboxEvents';
import { getContactChannels } from '../../services/contactLinking';
import { sendGmailEmail, replyToGmailThread } from '../../services/gmailApi';
import { sendOutlookEmail, replyToOutlookMessage } from '../../services/microsoftMail';
import type { EmailAttachment } from '../../services/emailAttachments';
import { listTwilioNumbers } from '../../services/twilioNumbers';
import { sendSms } from '../../services/sendSms';
import { sendConversationEmail } from '../../services/emailSend';
import { supabase } from '../../lib/supabase';
import { getGoogleErrorMessage } from '../../utils/googleAuthErrors';
import type { Conversation, Message, InboxEvent, MessageChannel, Contact } from '../../types';
import type { TwilioNumber } from '../../services/twilioNumbers';
import { reportBackgroundError } from '../../lib/errors';
import { threadMailboxFromMessages } from '../../lib/microsoftAccounts';
import { threadGoogleMailboxFromMessages } from '../../lib/googleAccounts';

interface MessageThreadProps {
  conversation: Conversation;
  onConversationUpdate: () => void;
  onToggleContactPanel: () => void;
  showContactPanel: boolean;
}

interface ThreadItem {
  type: 'message' | 'event' | 'day-separator';
  data: Message | InboxEvent | string;
  timestamp: string;
}

export function MessageThread({
  conversation,
  onConversationUpdate,
  onToggleContactPanel,
  showContactPanel,
}: MessageThreadProps) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const canManageTasks = usePermission('tasks.manage');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | false>(false);
  const [sending, setSending] = useState(false);
  const [availableChannels, setAvailableChannels] = useState<{ channel: MessageChannel; identifier: string }[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<MessageChannel>('sms');
  // On a phone the composer (channel tabs, From, To, Subject, body, toolbar) would take half the screen, so it starts as a one-line bar.
  const isPhone = useDevice().device === 'phone';
  const [composerOpen, setComposerOpen] = useState(false);
  const composerHidden = isPhone && !composerOpen;
  const [fromNumbers, setFromNumbers] = useState<TwilioNumber[]>([]);
  const [emailThread, setEmailThread] = useState<{ threadId: string; subject: string } | null>(null);
  const [taskPrefillMessage, setTaskPrefillMessage] = useState<Message | null>(null);

  const loadThread = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const [messagesResult, eventsResult, commentsResult] = await Promise.allSettled([
        getRecentMessages(conversation.id, 100),
        getInboxEvents(conversation.id),
        getInternalComments(conversation.id),
      ]);

      const messagesData = messagesResult.status === 'fulfilled' ? messagesResult.value : [];
      const eventsData = eventsResult.status === 'fulfilled' ? eventsResult.value : [];
      const commentsData = commentsResult.status === 'fulfilled' ? commentsResult.value : [];

      if (messagesResult.status === 'rejected') {
        console.error('Failed to load messages:', messagesResult.reason);
        const reason = messagesResult.reason;
        const msg = reason instanceof Error ? reason.message : String(reason);
        const isJwtError = msg.toLowerCase().includes('jwt') || msg.toLowerCase().includes('unauthorized') || msg.includes('401');
        setLoadError(isJwtError ? 'session' : 'generic');
      }
      if (eventsResult.status === 'rejected') {
        console.error('Failed to load events:', eventsResult.reason);
      }

      setMessages([...messagesData, ...commentsData]);
      setEvents(eventsData);

      if (conversation.contact) {
        try {
          const channels = await getContactChannels(conversation.contact as Contact);
          setAvailableChannels(channels);

          if (channels.length > 0) {
            const lastMessage = messagesData[messagesData.length - 1];
            if (lastMessage && channels.find((c) => c.channel === lastMessage.channel)) {
              setSelectedChannel(lastMessage.channel);
            } else {
              setSelectedChannel(channels[0].channel);
            }
          }
        } catch (channelError) {
          console.error('Failed to load channels:', channelError);
        }
      }
    } catch (error) {
      console.error('Failed to load thread:', error);
      const msg = error instanceof Error ? error.message : String(error);
      const isJwtError = msg.toLowerCase().includes('jwt') || msg.toLowerCase().includes('unauthorized') || msg.includes('401');
      setLoadError(isJwtError ? 'session' : 'generic');
    } finally {
      setLoading(false);
    }
  }, [conversation.id, conversation.contact]);

  useEffect(() => {
    loadThread();
  }, [loadThread]);

  // Realtime: new or changed messages in this conversation (inbound texts/emails, sends from other
  // tabs or agents) refresh the thread in place, without the loading state.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      const [msgs, comments, evts] = await Promise.allSettled([
        getRecentMessages(conversation.id, 100),
        getInternalComments(conversation.id),
        getInboxEvents(conversation.id),
      ]);
      if (msgs.status === 'fulfilled') {
        setMessages([...msgs.value, ...(comments.status === 'fulfilled' ? comments.value : [])]);
      }
      if (evts.status === 'fulfilled') setEvents(evts.value);
    };
    const channel = supabase
      .channel(`conversation-thread-${conversation.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversation.id}` },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { refresh().catch(reportBackgroundError('MessageThread.realtime')); }, 300);
        },
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [conversation.id]);

  useEffect(() => {
    if (user?.organization_id) {
      listTwilioNumbers(user.organization_id)
        .then(setFromNumbers)
        .catch(reportBackgroundError('MessageThread.listTwilioNumbers'));
    }
  }, [user?.organization_id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const getThreadInfo = (): { threadId?: string; inReplyTo?: string; references?: string; lastSubject?: string } => {
    const emailMessages = messages.filter(
      (m) => m.channel === 'email' && (m.metadata as Record<string, unknown>)?.gmail_message_id
    );
    if (emailMessages.length === 0) return {};

    const lastEmail = emailMessages[emailMessages.length - 1];
    const meta = lastEmail.metadata as Record<string, unknown> | undefined;
    return {
      threadId: meta?.thread_id as string | undefined,
      inReplyTo: meta?.gmail_message_id as string | undefined,
      references: meta?.gmail_message_id as string | undefined,
      lastSubject: lastEmail.subject || undefined,
    };
  };

  // The last Outlook email in this thread we can reply to (its Graph id is stored as "ms:<id>").
  const getOutlookReplyTarget = (): { messageId?: string; lastSubject?: string } => {
    const outlook = messages.filter((m) => m.channel === 'email' && typeof m.external_id === 'string' && m.external_id.startsWith('ms:'));
    if (outlook.length === 0) return {};
    const last = outlook[outlook.length - 1];
    return { messageId: last.external_id as string, lastSubject: last.subject || undefined };
  };

  const handleSendMessage = async (body: string, subject?: string, extraMetadata?: Record<string, unknown>) => {
    if (!user?.organization_id || !conversation.contact) return;

    try {
      setSending(true);

      const channelConfig = availableChannels.find((c) => c.channel === selectedChannel);
      const isGmailConnected = user.gmail_connected;
      const isEmailChannel = selectedChannel === 'email';
      // Sender rail chosen in the composer (defaults to Gmail when connected).
      const sendVia = (extraMetadata?.send_via as string | undefined) ?? (isGmailConnected ? 'gmail' : 'resend');

      if (isEmailChannel && sendVia === 'outlook' && channelConfig) {
        const fromConnectionId = extraMetadata?.from_connection_id as string | undefined;
        const target = getOutlookReplyTarget();
        const emailSubject = subject || target.lastSubject || 'No Subject';
        const optimistic: Message = {
          id: `temp-${Date.now()}`,
          organization_id: user.organization_id,
          conversation_id: conversation.id,
          contact_id: conversation.contact_id,
          channel: 'email',
          direction: 'outbound',
          body,
          subject: emailSubject,
          metadata: { to_email: channelConfig.identifier, sent_via: 'outlook' },
          status: 'pending',
          external_id: null,
          sent_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          hidden_at: null,
          hidden_by_user_id: null,
        };
        setMessages((prev) => [...prev, optimistic]);
        try {
          if (target.messageId) {
            await replyToOutlookMessage({ messageId: target.messageId, htmlBody: body, fromConnectionId });
          } else {
            await sendOutlookEmail({
              to: channelConfig.identifier,
              subject: emailSubject,
              htmlBody: body,
              cc: extraMetadata?.cc as string | undefined,
              bcc: extraMetadata?.bcc as string | undefined,
              fromConnectionId,
            });
          }
          setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, status: 'delivered' } : m)));
        } catch (outlookError) {
          const errorMsg = outlookError instanceof Error ? outlookError.message : 'Unknown error';
          console.error('Outlook send failed:', errorMsg);
          setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, status: 'failed', metadata: { ...m.metadata, error_message: errorMsg } } : m)));
          showToast('warning', 'Email failed', errorMsg);
          throw outlookError;
        }
      } else if (isEmailChannel && sendVia === 'gmail' && isGmailConnected && channelConfig) {
        const threadInfo = getThreadInfo();

        const optimisticMessage: Message = {
          id: `temp-${Date.now()}`,
          organization_id: user.organization_id,
          conversation_id: conversation.id,
          contact_id: conversation.contact_id,
          channel: 'email',
          direction: 'outbound',
          body,
          subject: subject || threadInfo.lastSubject || '',
          metadata: { to_email: channelConfig.identifier, sent_via: 'gmail' },
          status: 'pending',
          external_id: null,
          sent_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          hidden_at: null,
          hidden_by_user_id: null,
        };

        setMessages((prev) => [...prev, optimisticMessage]);

        try {
          const emailSubject = subject || threadInfo.lastSubject || 'No Subject';
          const cc = extraMetadata?.cc as string | undefined;
          const bcc = extraMetadata?.bcc as string | undefined;
          const attachments = extraMetadata?.attachments as EmailAttachment[] | undefined;
          // Set by the composer only for users with 2+ Google accounts; omitted, the server picks
          // (a reply: the mailbox the thread arrived on, else the primary).
          const fromConnectionId = extraMetadata?.from_connection_id as string | undefined;

          if (threadInfo.threadId) {
            await replyToGmailThread({
              to: channelConfig.identifier,
              subject: emailSubject.startsWith('Re:') ? emailSubject : `Re: ${emailSubject}`,
              htmlBody: body,
              threadId: threadInfo.threadId,
              inReplyTo: threadInfo.inReplyTo,
              references: threadInfo.references,
              conversationId: conversation.id,
              contactId: conversation.contact_id,
              cc,
              bcc,
              attachments,
              fromConnectionId,
            });
          } else {
            await sendGmailEmail({
              to: channelConfig.identifier,
              subject: emailSubject,
              htmlBody: body,
              conversationId: conversation.id,
              contactId: conversation.contact_id,
              cc,
              bcc,
              attachments,
              fromConnectionId,
            });
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === optimisticMessage.id ? { ...m, status: 'delivered' } : m
            )
          );
        } catch (gmailError) {
          const errorMsg = gmailError instanceof Error ? gmailError.message : 'Unknown error';
          console.error('Gmail send failed:', errorMsg);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === optimisticMessage.id
                ? { ...m, status: 'failed', metadata: { ...m.metadata, error_message: errorMsg } }
                : m
            )
          );

          const errInfo = getGoogleErrorMessage(errorMsg, 'gmail');
          showToast('warning', errInfo.title, errInfo.description);
          throw gmailError;
        }
      } else {
        const mediaUrls = extraMetadata?.media_urls as string[] | undefined;
        const cleanMetadata: Record<string, unknown> = { ...extraMetadata };
        delete cleanMetadata.media_urls;

        if (selectedChannel === 'sms' && channelConfig) {
          cleanMetadata.to_number = channelConfig.identifier;
        } else if (selectedChannel === 'email' && channelConfig) {
          cleanMetadata.to_email = channelConfig.identifier;
        }

        const newMessage = await createMessage(
          user.organization_id,
          conversation.id,
          conversation.contact_id,
          selectedChannel,
          'outbound',
          body,
          cleanMetadata,
          subject
        );

        if (mediaUrls && mediaUrls.length > 0) {
          await supabase
            .from('messages')
            .update({ media_urls: mediaUrls })
            .eq('id', newMessage.id);
          newMessage.media_urls = mediaUrls;
        }

        setMessages((prev) => [...prev, newMessage]);

        if (selectedChannel === 'email') {
          // Org Resend sender: email-send applies the Email Services Defaults (from, reply-to,
          // unsubscribe group) and records the Resend id on the row for delivery tracking.
          sendConversationEmail(newMessage.id)
            .then((res) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === newMessage.id
                    ? res.success
                      ? { ...m, status: 'sent' }
                      : { ...m, status: 'failed', metadata: { ...m.metadata, error_message: res.error } }
                    : m
                )
              );
              if (!res.success) showToast('warning', 'Email failed', res.error || 'Failed to send');
            })
            .catch((err) => {
              const errorMsg = err instanceof Error ? err.message : 'Failed to send';
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === newMessage.id
                    ? { ...m, status: 'failed', metadata: { ...m.metadata, error_message: errorMsg } }
                    : m
                )
              );
            });
        }

        if (selectedChannel === 'sms') {
          sendSms(newMessage.id)
            .then(({ status }) => {
              setMessages((prev) =>
                prev.map((m) => m.id === newMessage.id ? { ...m, status: status as Message['status'] } : m)
              );
            })
            .catch((err) => {
              const errorMsg = err instanceof Error ? err.message : 'Failed to send';
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === newMessage.id
                    ? { ...m, status: 'failed', metadata: { ...m.metadata, error_message: errorMsg } }
                    : m
                )
              );
            });
        }
      }

      onConversationUpdate();
    } catch (error) {
      console.error('Failed to send message:', error);
    } finally {
      setSending(false);
    }
  };

  const handleSendInternalComment = async (body: string, mentions: string[]) => {
    if (!user?.organization_id) return;

    try {
      setSending(true);

      const newMessage = await createMessage(
        user.organization_id,
        conversation.id,
        conversation.contact_id,
        'sms',
        'system',
        body,
        {
          type: 'internal_comment',
          author_id: user.id,
          author_name: user.name,
          mentions,
        }
      );

      void syncMentionsForSource({
        orgId: user.organization_id,
        sourceType: 'conversation_message',
        sourceId: newMessage.id,
        text: body,
        createdBy: user.id,
      });

      setMessages((prev) => [...prev, newMessage]);
      onConversationUpdate();
    } catch (error) {
      console.error('Failed to send internal comment:', error);
      showToast('warning', 'Failed to send comment', 'Please try again.');
      throw error;
    } finally {
      setSending(false);
    }
  };

  // The last real SMS in the thread (not internal comments), used to default
  // the composer's From picker to the number this conversation is on.
  const lastSmsMeta = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.channel === 'sms' && m.direction !== 'system') {
        const meta = (m.metadata || {}) as Record<string, unknown>;
        return {
          direction: m.direction,
          from_number: meta.from_number as string | undefined,
          to_number: meta.to_number as string | undefined,
        };
      }
    }
    return undefined;
  })();

  const threadItems = buildThreadItems(messages, events);
  const hasNoMessages = messages.length === 0;
  // Threads driven by an external AI agent are mirrored in for visibility only —
  // the agent owns the number, so replying from here would double-respond.
  const isExternalAgent = conversation.provider === 'external_agent';
  const agentMeta = conversation.conversation_metadata as Record<string, unknown> | undefined;
  const agentName = (agentMeta?.assistant_name as string | undefined) || 'an AI agent';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ConversationHeader
        conversation={conversation}
        onConversationUpdate={onConversationUpdate}
        onToggleContactPanel={onToggleContactPanel}
        showContactPanel={showContactPanel}
      />

      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin w-8 h-8 border-2 border-hud-gold border-t-transparent rounded-full" />
          </div>
        ) : loadError && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <AlertTriangle className="w-8 h-8 text-hud-rust" />
            <p className="text-hud-cream-dim text-sm">
              {loadError === 'session'
                ? 'Your session has expired. Please log out and log back in.'
                : 'Failed to load messages'}
            </p>
            <button
              onClick={loadThread}
              className="flex items-center gap-2 px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft rounded-lg text-sm transition-colors"
            >
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        ) : hasNoMessages ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-xs">
              <div className="w-14 h-14 rounded-full bg-hud-bg-card flex items-center justify-center mx-auto mb-4">
                <MessageSquare className="w-7 h-7 text-hud-cream-mute" />
              </div>
              <p className="text-hud-cream-soft font-medium mb-1">
                Start the conversation
              </p>
              <p className="text-sm text-hud-cream-mute">
                Send an email or SMS to begin communicating with this contact.
              </p>
            </div>
          </div>
        ) : (
          threadItems.map((item, index) => {
            if (item.type === 'day-separator') {
              return (
                <DaySeparator key={`day-${index}`} date={item.data as string} />
              );
            }

            if (item.type === 'event') {
              return (
                <SystemEventItem key={`event-${(item.data as InboxEvent).id}`} event={item.data as InboxEvent} />
              );
            }

            return (
              <MessageBubble
                key={(item.data as Message).id}
                message={item.data as Message}
                onOpenThread={(threadId, subject) => setEmailThread({ threadId, subject })}
                onRetry={(msgId, newStatus) => {
                  setMessages(prev =>
                    prev.map(m => m.id === msgId ? { ...m, status: newStatus as Message['status'] } : m)
                  );
                }}
                onCreateTask={canManageTasks ? (msg) => setTaskPrefillMessage(msg) : undefined}
              />
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {isExternalAgent ? (
        <div className="px-4 py-3 border-t border-hud-bg-elev bg-hud-bg-card/50">
          <div className="flex items-center justify-center gap-2 text-sm text-hud-cream-mute">
            <Bot size={16} />
            <span>{`This conversation is handled by ${agentName} and is read-only`}</span>
          </div>
        </div>
      ) : (
        <>
        {composerHidden && conversation.status !== 'closed' && (
          <div className="flex gap-2 border-t border-hud-bg-elev bg-hud-bg-card p-2" data-testid="composer-bar">
            {availableChannels.some((c) => c.channel === 'email') && (
              <button
                type="button"
                onClick={() => { setSelectedChannel('email'); setComposerOpen(true); }}
                className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-hud-gold-deep py-2.5 text-sm font-medium text-white touch-manipulation"
              >
                <Mail size={16} /> Reply by email
              </button>
            )}
            {availableChannels.some((c) => c.channel === 'sms') && (
              <button
                type="button"
                onClick={() => { setSelectedChannel('sms'); setComposerOpen(true); }}
                className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-hud-bg-elev py-2.5 text-sm font-medium text-white touch-manipulation"
              >
                <MessageSquare size={16} /> Text
              </button>
            )}
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              aria-label="Write a note or message"
              className="flex items-center justify-center rounded-lg bg-hud-bg-elev px-3 text-hud-cream-soft touch-manipulation"
            >
              <PencilLine size={18} />
            </button>
          </div>
        )}
        {isPhone && composerOpen && (
          <button
            type="button"
            onClick={() => setComposerOpen(false)}
            className="flex w-full items-center justify-center gap-1 border-t border-hud-bg-elev bg-hud-bg-card py-1 text-xs text-hud-cream-dim touch-manipulation"
          >
            <ChevronDown size={14} /> Hide composer
          </button>
        )}
        <div className={composerHidden ? 'hidden' : undefined}>
        <MessageComposer
          onSend={handleSendMessage}
          onSendInternalComment={handleSendInternalComment}
          sending={sending}
          disabled={conversation.status === 'closed'}
          availableChannels={availableChannels}
          selectedChannel={selectedChannel}
          onChannelChange={setSelectedChannel}
          showSubject={selectedChannel === 'email'}
          contact={conversation.contact as Contact}
          conversation={conversation}
          gmailConnected={user?.gmail_connected || false}
          fromNumbers={fromNumbers}
          lastSmsMeta={lastSmsMeta}
          threadMailbox={threadMailboxFromMessages(messages)}
          threadGoogleMailbox={threadGoogleMailboxFromMessages(messages)}
        />
        </div>
        </>
      )}

      {emailThread && (
        <EmailThreadDrawer
          threadId={emailThread.threadId}
          subject={emailThread.subject}
          onClose={() => setEmailThread(null)}
          conversationId={conversation.id}
          contactId={conversation.contact_id}
          defaultTo={availableChannels.find((c) => c.channel === 'email')?.identifier}
          onSent={loadThread}
        />
      )}

      {taskPrefillMessage && (
        <CreateTaskModal
          prefill={{
            title: taskPrefillMessage.subject || taskPrefillMessage.body?.slice(0, 120),
            description: taskPrefillMessage.body,
            originType: 'conversation_message',
            originId: taskPrefillMessage.id,
            contactId: conversation.contact_id,
          }}
          onClose={() => setTaskPrefillMessage(null)}
          onCreated={() => setTaskPrefillMessage(null)}
        />
      )}
    </div>
  );
}

function DaySeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-4 my-4">
      <div className="flex-1 h-px bg-hud-bg-elev" />
      <span className="text-xs text-hud-cream-mute font-medium">{date}</span>
      <div className="flex-1 h-px bg-hud-bg-elev" />
    </div>
  );
}

function SystemEventItem({ event }: { event: InboxEvent }) {
  const getEventText = () => {
    switch (event.event_type) {
      case 'assigned':
        return `Conversation assigned to ${(event.payload as { assigned_user_name?: string }).assigned_user_name || 'a team member'}`;
      case 'status_changed':
        return `Status changed to ${(event.payload as { new_status?: string }).new_status}`;
      case 'conversation_created':
        return 'Conversation started';
      case 'contact_merged':
        return 'Contact information updated';
      default:
        return event.event_type;
    }
  };

  return (
    <div className="flex items-center justify-center my-2">
      <span className="text-xs text-hud-cream-dim bg-hud-bg-elev px-3 py-1 rounded-full">
        {getEventText()} - {formatTime(event.created_at)}
      </span>
    </div>
  );
}

function buildThreadItems(messages: Message[], events: InboxEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];

  messages.forEach((msg) => {
    items.push({
      type: 'message',
      data: msg,
      timestamp: msg.sent_at,
    });
  });

  events.forEach((evt) => {
    items.push({
      type: 'event',
      data: evt,
      timestamp: evt.created_at,
    });
  });

  items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const withSeparators: ThreadItem[] = [];
  let lastDate = '';

  items.forEach((item) => {
    const itemDate = formatDate(item.timestamp);
    if (itemDate !== lastDate) {
      withSeparators.push({
        type: 'day-separator',
        data: itemDate,
        timestamp: item.timestamp,
      });
      lastDate = itemDate;
    }
    withSeparators.push(item);
  });

  return withSeparators;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}
