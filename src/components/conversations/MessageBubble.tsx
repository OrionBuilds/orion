import { useState, useEffect } from 'react';
import { Phone, Mail, PhoneCall, MessageCircle, Check, CheckCheck, Clock, AlertCircle, Eye, Archive, Trash2, MoreHorizontal, Paperclip, Download, FileText, Image, File, ChevronDown, ChevronUp, StickyNote, ExternalLink, RefreshCw, X, Mic, Bot, FileAudio, ListPlus, LayoutDashboard } from 'lucide-react';
import { trashGmailMessage, archiveGmailMessage, downloadAttachment, listMessageAttachments } from '../../services/gmailApi';
import { getRecordingUrl } from '../../services/callRecordings';
import { retrySms } from '../../services/sendSms';
import { MentionText } from '../shared/MentionText';
import type { Message, MessageChannel, MessageStatus } from '../../types';
import { formatFileSize } from '../../utils/formatters';
import { reportBackgroundError } from '../../lib/errors';
import { Portal } from '../shared/Portal';

const EMAIL_PREVIEW_LENGTH = 250;

interface MessageBubbleProps {
  message: Message;
  onMessageAction?: (messageId: string, action: 'archived' | 'trashed') => void;
  onOpenThread?: (threadId: string, subject: string) => void;
  onRetry?: (messageId: string, newStatus: string) => void;
  /** A2: "Create task" hover action -- Macro's core task loop. */
  onCreateTask?: (message: Message) => void;
}

function cleanEmailBody(body: string): string {
  let cleaned = body
    .replace(/\( https?:\/\/[^\s)]+\)/g, '')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/={3,}/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

export function MessageBubble({ message, onMessageAction, onOpenThread, onRetry, onCreateTask }: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const isOutbound = message.direction === 'outbound';
  const isSystem = message.direction === 'system';
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const isGmailMessage = message.channel === 'email' && metadata?.gmail_message_id;
  const isEmailChannel = message.channel === 'email';
  const gmailMessageId = metadata?.gmail_message_id as string | undefined;
  const hasAttachments = metadata?.has_attachments === true;
  const fromEmail = metadata?.from_email as string | undefined;
  const fromName = metadata?.from_name as string | undefined;

  const handleRetrySms = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { status } = await retrySms(message.id);
      onRetry?.(message.id, status);
    } catch (err) {
      console.error('Retry failed:', err);
    } finally {
      setRetrying(false);
    }
  };

  const handleArchive = async () => {
    if (!gmailMessageId) return;
    setActionLoading(true);
    try {
      await archiveGmailMessage(gmailMessageId);
      onMessageAction?.(message.id, 'archived');
    } catch (err) {
      console.error('Failed to archive:', err);
    } finally {
      setActionLoading(false);
      setShowActions(false);
    }
  };

  const handleTrash = async () => {
    if (!gmailMessageId) return;
    setActionLoading(true);
    try {
      await trashGmailMessage(gmailMessageId);
      onMessageAction?.(message.id, 'trashed');
    } catch (err) {
      console.error('Failed to trash:', err);
    } finally {
      setActionLoading(false);
      setShowActions(false);
    }
  };

  if (message.message_type === 'call_event') {
    return <CallEventBubble message={message} />;
  }

  if (message.message_type === 'summary') {
    return <CallSummaryBubble message={message} />;
  }

  if (message.message_type === 'call_recording') {
    return <RecordingBubble message={message} />;
  }

  if (isSystem) {
    const isInternalComment = metadata?.type === 'internal_comment';
    if (isInternalComment) {
      return <InternalCommentBubble message={message} metadata={metadata} />;
    }

    return (
      <div className="flex items-center justify-center my-2">
        <span className="text-xs text-hud-cream-dim bg-hud-bg-elev px-3 py-1 rounded-full">
          {message.body}
        </span>
      </div>
    );
  }

  if (isEmailChannel) {
    const threadId = metadata?.thread_id as string | undefined;
    return <EmailBubble
      message={message}
      isOutbound={isOutbound}
      isGmailMessage={!!isGmailMessage}
      gmailMessageId={gmailMessageId}
      hasAttachments={hasAttachments}
      fromEmail={fromEmail}
      fromName={fromName}
      expanded={expanded}
      onToggleExpand={() => setExpanded(!expanded)}
      showActions={showActions}
      onToggleActions={() => setShowActions(!showActions)}
      onCloseActions={() => setShowActions(false)}
      onArchive={handleArchive}
      onTrash={handleTrash}
      actionLoading={actionLoading}
      downloadingAttId={downloadingAttId}
      threadId={threadId}
      onOpenThread={onOpenThread}
      onCreateTask={onCreateTask ? () => onCreateTask(message) : undefined}
      onDownloadAttachment={async (attId: string, filename: string) => {
        if (!message.external_id) return;
        setDownloadingAttId(attId);
        try {
          const blob = await downloadAttachment(message.external_id, attId);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error('Download failed:', err);
        } finally {
          setDownloadingAttId(null);
        }
      }}
    />;
  }

  const mediaUrls: string[] = message.media_urls?.length
    ? message.media_urls
    : (metadata?.media_urls as string[] | undefined) || [];

  return (
    <div
      className={`group flex items-center gap-1.5 ${isOutbound ? 'justify-end' : 'justify-start'}`}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isOutbound && onCreateTask && message.body && (
        <button
          onClick={() => onCreateTask(message)}
          title="Create task from this message"
          className="self-center opacity-0 group-hover:opacity-100 reveal-on-touch p-1.5 rounded-lg text-hud-cream-mute hover:text-hud-gold-soft hover:bg-hud-bg-elev transition-opacity flex-shrink-0"
        >
          <ListPlus className="w-4 h-4" />
        </button>
      )}
      <div
        className={`max-w-[92%] sm:max-w-[70%] rounded-2xl overflow-hidden ${
          isOutbound
            ? 'bg-hud-gold-deep text-white rounded-br-md'
            : 'bg-hud-bg-elev text-white rounded-bl-md'
        }`}
      >
        {/* Attribute any AI-sent message (Clara or a mirrored external
            agent) — otherwise an AI SMS is indistinguishable from one a
            human sent. */}
        {isOutbound && message.sender_name && (
          <div className="px-4 pt-2 pb-0">
            <div className="flex items-center gap-1.5">
              <Bot size={12} className="text-hud-gold/25" />
              <span className="text-[11px] font-medium text-hud-gold/25">{message.sender_name}</span>
            </div>
          </div>
        )}

        {mediaUrls.length > 0 && (
          <MmsMediaGallery urls={mediaUrls} isOutbound={isOutbound} />
        )}

        {message.body && (
          <div className="px-4 py-2.5 whitespace-pre-wrap break-words">
            {message.body}
          </div>
        )}

        <div className={`flex items-center justify-end gap-2 px-4 pb-2.5 ${!message.body ? 'pt-1.5' : ''} ${isOutbound ? 'text-hud-gold/25' : 'text-hud-cream-dim'}`}>
          <ChannelIndicator channel={message.channel} isOutbound={isOutbound} />
          <span className="text-xs">{formatTime(message.sent_at)}</span>
          {isOutbound && <StatusIndicator status={message.status} />}
        </div>

        {message.status === 'failed' && (
          <div className="mx-3 mb-3 p-2 bg-hud-plum/60 rounded text-xs text-hud-plum/40">
            <div className="flex items-center gap-1 mb-1">
              <AlertCircle size={12} />
              {message.metadata?.error_message
                ? String(message.metadata.error_message)
                : 'Failed to send'}
            </div>
            {message.channel === 'sms' && (
              <button
                onClick={handleRetrySms}
                disabled={retrying}
                className="flex items-center gap-1 text-hud-plum/25 hover:text-white transition-colors disabled:opacity-50"
              >
                <RefreshCw size={11} className={retrying ? 'animate-spin' : ''} />
                {retrying ? 'Retrying...' : 'Retry'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MmsMediaGallery({ urls, isOutbound }: { urls: string[]; isOutbound: boolean }) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  const isImage = (url: string) =>
    /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) ||
    url.includes('image/');

  return (
    <>
      <div className={`grid gap-0.5 ${urls.length === 1 ? 'grid-cols-1' : 'grid-cols-2'} max-w-[260px]`}>
        {urls.map((url, i) =>
          isImage(url) ? (
            <button
              key={i}
              onClick={() => setLightbox(url)}
              className="block overflow-hidden"
            >
              <img
                src={url}
                alt={`attachment ${i + 1}`}
                className="w-full object-cover max-h-[180px] hover:opacity-90 transition-opacity"
              />
            </button>
          ) : (
            <a
              key={i}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 px-3 py-2 text-xs ${
                isOutbound ? 'bg-hud-gold-deep/50 hover:bg-hud-gold-deep text-hud-gold/15' : 'bg-hud-cream-mute/50 hover:bg-hud-cream-mute text-hud-cream-soft'
              } transition-colors`}
            >
              <File size={14} />
              <span className="truncate">Attachment {i + 1}</span>
              <ExternalLink size={12} className="shrink-0 opacity-70" />
            </a>
          )
        )}
      </div>

      {lightbox && (
        <Portal><div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white"
            onClick={() => setLightbox(null)}
          >
            <X size={24} />
          </button>
          <img
            src={lightbox}
            alt="media"
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={e => e.stopPropagation()}
          />
        </div></Portal>
      )}
    </>
  );
}

function InternalCommentBubble({ message, metadata }: { message: Message; metadata?: Record<string, unknown> }) {
  const authorName = (metadata?.author_name as string) || 'Team member';

  return (
    <div className="flex justify-center my-3">
      <div className="max-w-[96%] sm:max-w-[85%] w-full rounded-lg border border-hud-rust/25 bg-hud-rust/10 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-hud-rust/60 bg-hud-rust/40">
          <StickyNote size={14} className="text-hud-rust" />
          <span className="text-xs font-medium text-hud-rust">{authorName}</span>
          <span className="text-xs text-hud-rust ml-auto">{formatTime(message.sent_at)}</span>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm text-hud-rust whitespace-pre-wrap break-words leading-relaxed">
            <MentionText text={message.body} />
          </p>
        </div>
        <div className="px-4 pb-2">
          <span className="text-[10px] text-hud-rust italic">Internal note - not visible to contact</span>
        </div>
      </div>
    </div>
  );
}

function CallEventBubble({ message }: { message: Message }) {
  return (
    <div className="flex items-center justify-center my-2">
      <span className="inline-flex items-center gap-1.5 text-xs text-hud-cream-dim bg-hud-bg-elev/80 px-3 py-1.5 rounded-full">
        <PhoneCall size={12} />
        {message.body}
        <span className="text-hud-cream-mute ml-1">{formatTime(message.sent_at)}</span>
      </span>
    </div>
  );
}

function RecordingBubble({ message }: { message: Message }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = (message.metadata as Record<string, unknown>) || {};
  const callSid = meta.call_sid as string | undefined;
  const seconds = meta.duration_seconds as number | undefined;

  const load = async () => {
    if (!callSid) { setError('No recording reference'); return; }
    setLoading(true);
    setError(null);
    try {
      setUrl(await getRecordingUrl({ callSid }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex justify-center my-3">
      <div className="max-w-[96%] sm:max-w-[85%] w-full rounded-lg border border-hud-bg-elev bg-hud-bg-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-hud-bg-elev">
          <FileAudio size={14} className="text-hud-gold" />
          <span className="text-xs font-medium text-hud-cream-soft">Call recording{seconds ? ` · ${seconds}s` : ''}</span>
          <span className="text-xs text-hud-cream-mute ml-auto">{formatTime(message.sent_at)}</span>
        </div>
        <div className="px-4 py-3 space-y-2">
          {message.body && <p className="text-sm text-hud-cream-dim whitespace-pre-wrap break-words leading-relaxed">{message.body}</p>}
          {url ? (
            <audio controls src={url} className="w-full" />
          ) : (
            <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-lg bg-hud-gold px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50">
              <Mic size={12} /> {loading ? 'Loading…' : 'Play recording'}
            </button>
          )}
          {error && <p className="text-xs text-hud-rust">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function CallSummaryBubble({ message }: { message: Message }) {
  return (
    <div className="flex justify-center my-3">
      <div className="max-w-[96%] sm:max-w-[85%] w-full rounded-lg border border-hud-teal/40 bg-hud-teal/20 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-hud-teal/30 bg-hud-teal/30">
          <FileAudio size={14} className="text-hud-teal" />
          <span className="text-xs font-medium text-hud-teal">Call Summary</span>
          <span className="text-xs text-hud-teal ml-auto">{formatTime(message.sent_at)}</span>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm text-hud-teal/15 whitespace-pre-wrap break-words leading-relaxed">
            {message.body}
          </p>
        </div>
      </div>
    </div>
  );
}

function EmailBubble({
  message,
  isOutbound,
  isGmailMessage,
  gmailMessageId,
  hasAttachments,
  fromEmail,
  fromName,
  expanded,
  onToggleExpand,
  showActions,
  onToggleActions,
  onCloseActions,
  onArchive,
  onTrash,
  actionLoading,
  downloadingAttId,
  onDownloadAttachment,
  threadId,
  onOpenThread,
  onCreateTask,
}: {
  message: Message;
  isOutbound: boolean;
  isGmailMessage: boolean;
  gmailMessageId?: string;
  hasAttachments: boolean;
  fromEmail?: string;
  fromName?: string;
  expanded: boolean;
  onToggleExpand: () => void;
  showActions: boolean;
  onToggleActions: () => void;
  onCloseActions: () => void;
  onArchive: () => void;
  onTrash: () => void;
  actionLoading: boolean;
  downloadingAttId: string | null;
  onDownloadAttachment: (attId: string, filename: string) => void;
  threadId?: string;
  onOpenThread?: (threadId: string, subject: string) => void;
  onCreateTask?: () => void;
}) {
  const cleanedBody = cleanEmailBody(message.body);
  const isLong = cleanedBody.length > EMAIL_PREVIEW_LENGTH;
  const displayBody = expanded || !isLong
    ? cleanedBody
    : cleanedBody.substring(0, EMAIL_PREVIEW_LENGTH) + '...';

  const senderDisplay = fromName || fromEmail || (isOutbound ? 'You' : 'Unknown');

  return (
    <div
      className={`group flex ${isOutbound ? 'justify-end' : 'justify-start'}`}
      onMouseLeave={onCloseActions}
    >
      {isOutbound && isGmailMessage && (
        <GmailActionMenu
          position="left"
          showActions={showActions}
          onToggleActions={onToggleActions}
          onCloseActions={onCloseActions}
          onArchive={onArchive}
          onTrash={onTrash}
          actionLoading={actionLoading}
        />
      )}

      <div className={`max-w-[94%] sm:max-w-[75%] rounded-xl border overflow-hidden ${
        isOutbound
          ? 'bg-hud-gold-deep/30 border-hud-gold-deep/50'
          : 'bg-hud-bg-card border-hud-cream-mute/50'
      }`}>
        <div className={`px-4 py-2.5 border-b ${
          isOutbound ? 'border-hud-gold-deep/30 bg-hud-gold-deep/40' : 'border-hud-cream-mute/30 bg-hud-bg-elev/40'
        }`}>
          <div className="flex items-center gap-2">
            <Mail size={14} className={isOutbound ? 'text-hud-gold-soft' : 'text-hud-cream-dim'} />
            <span className="text-sm font-medium text-white truncate">
              {isOutbound ? 'You' : senderDisplay}
            </span>
            {!isOutbound && fromEmail && fromName && (
              <span className="text-xs text-hud-cream-mute truncate">&lt;{fromEmail}&gt;</span>
            )}
          </div>
          {message.subject && (
            <div className={`text-xs mt-1 ${isOutbound ? 'text-hud-gold-soft' : 'text-hud-cream-soft'} font-medium`}>
              {message.subject}
            </div>
          )}
        </div>

        <div className="px-4 py-3">
          <div className={`text-sm whitespace-pre-wrap break-words leading-relaxed ${
            isOutbound ? 'text-hud-gold/15' : 'text-hud-cream-soft'
          }`}>
            {displayBody}
          </div>
          {isLong && (
            <button
              onClick={onToggleExpand}
              className={`flex items-center gap-1 mt-2 text-xs font-medium transition-colors ${
                isOutbound
                  ? 'text-hud-gold-soft hover:text-hud-gold-soft'
                  : 'text-hud-cream-dim hover:text-hud-cream-soft'
              }`}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>

        {hasAttachments && gmailMessageId && (
          <div className="px-4 pb-3">
            <AttachmentStrip
              gmailMessageId={gmailMessageId}
              externalId={message.external_id ?? undefined}
              isOutbound={isOutbound}
              downloadingAttId={downloadingAttId}
              onDownload={onDownloadAttachment}
            />
          </div>
        )}

        <div className={`px-4 py-2 border-t flex items-center justify-between ${
          isOutbound ? 'border-hud-gold-deep/30' : 'border-hud-cream-mute/30'
        }`}>
          <div className="flex items-center gap-2">
            {isGmailMessage && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                isOutbound ? 'bg-hud-gold-deep/50 text-hud-gold-soft' : 'bg-hud-cream-mute/50 text-hud-cream-dim'
              }`}>Gmail</span>
            )}
            {threadId && onOpenThread && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenThread(threadId, message.subject || 'Email Thread');
                }}
                className={`flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded transition-colors ${
                  isOutbound
                    ? 'text-hud-gold-soft hover:bg-hud-gold-deep/50 hover:text-hud-gold/25'
                    : 'text-hud-cream-dim hover:bg-hud-cream-mute/50 hover:text-hud-cream-soft'
                }`}
              >
                <ExternalLink size={10} />
                View thread
              </button>
            )}
            {onCreateTask && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateTask();
                }}
                title="Create task from this email"
                className={`flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded transition-colors ${
                  isOutbound
                    ? 'text-hud-gold-soft hover:bg-hud-gold-deep/50 hover:text-hud-gold/25'
                    : 'text-hud-cream-dim hover:bg-hud-cream-mute/50 hover:text-hud-cream-soft'
                }`}
              >
                <ListPlus size={10} />
                Create task
              </button>
            )}
          </div>
          <div className={`flex items-center gap-2 ${isOutbound ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`}>
            <span className="text-xs">{formatTime(message.sent_at)}</span>
            {isOutbound && <StatusIndicator status={message.status} />}
          </div>
        </div>

        {message.status === 'failed' && message.metadata?.error_message && (
          <div className="mx-4 mb-3 p-2 bg-hud-plum/50 rounded text-xs text-hud-plum/40 flex items-center gap-1">
            <AlertCircle size={12} />
            {String(message.metadata.error_message)}
          </div>
        )}
      </div>

      {!isOutbound && isGmailMessage && (
        <GmailActionMenu
          position="right"
          showActions={showActions}
          onToggleActions={onToggleActions}
          onCloseActions={onCloseActions}
          onArchive={onArchive}
          onTrash={onTrash}
          actionLoading={actionLoading}
        />
      )}
    </div>
  );
}

function GmailActionMenu({
  position,
  showActions,
  onToggleActions,
  onCloseActions,
  onArchive,
  onTrash,
  actionLoading,
}: {
  position: 'left' | 'right';
  showActions: boolean;
  onToggleActions: () => void;
  onCloseActions: () => void;
  onArchive: () => void;
  onTrash: () => void;
  actionLoading: boolean;
}) {
  return (
    <div className={`relative flex items-start ${position === 'left' ? 'mr-1' : 'ml-1'}`}>
      <button
        onClick={onToggleActions}
        className="p-1 rounded text-hud-cream-mute hover:text-hud-cream-soft hover:bg-hud-bg-elev opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity"
      >
        <MoreHorizontal size={14} />
      </button>
      {showActions && (
        <>
          <div className="fixed inset-0 z-10" onClick={onCloseActions} />
          <div className={`absolute ${position === 'left' ? 'right-0' : 'left-0'} top-full mt-1 z-20 bg-hud-bg-card border border-hud-cream-mute rounded-lg shadow-lg min-w-[140px]`}>
            <button
              onClick={onArchive}
              disabled={actionLoading}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded-t-lg disabled:opacity-50"
            >
              <Archive size={14} />
              Archive
            </button>
            <button
              onClick={onTrash}
              disabled={actionLoading}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-plum hover:bg-hud-bg-elev rounded-b-lg disabled:opacity-50"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ChannelIndicator({ channel, isOutbound }: { channel: MessageChannel; isOutbound: boolean }) {
  const iconClass = `w-3 h-3 ${isOutbound ? 'text-hud-gold/25' : 'text-hud-cream-dim'}`;

  switch (channel) {
    case 'sms':
      return <Phone className={iconClass} />;
    case 'email':
      return <Mail className={iconClass} />;
    case 'voice':
      return <PhoneCall className={iconClass} />;
    case 'webchat':
      return <MessageCircle className={iconClass} />;
    case 'portal':
      return <LayoutDashboard className={iconClass} />;
    default:
      return null;
  }
}

function StatusIndicator({ status }: { status: MessageStatus }) {
  switch (status) {
    case 'pending':
      return <Clock size={12} className="text-hud-gold/25" />;
    case 'sent':
      return <Check size={12} className="text-hud-gold/25" />;
    case 'delivered':
      return <CheckCheck size={12} className="text-hud-gold/25" />;
    case 'read':
      return <Eye size={12} className="text-hud-gold/25" />;
    case 'failed':
      return <AlertCircle size={12} className="text-hud-plum/40" />;
    default:
      return null;
  }
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function AttachmentIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <Image size={14} />;
  if (mimeType === 'application/pdf') return <FileText size={14} />;
  return <File size={14} />;
}
interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

function AttachmentStrip({
  gmailMessageId,
  externalId,
  isOutbound,
  downloadingAttId,
  onDownload,
}: {
  gmailMessageId: string;
  externalId?: string;
  isOutbound: boolean;
  downloadingAttId: string | null;
  onDownload: (attachmentId: string, filename: string) => void;
}) {
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!externalId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    listMessageAttachments(externalId)
      .then((res: { attachments?: AttachmentInfo[] }) => {
        if (!cancelled) setAttachments(res.attachments || []);
      })
      .catch(reportBackgroundError('MessageBubble.listMessageAttachments'))
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [externalId]);

  if (!loaded || attachments.length === 0) {
    return (
      <div className={`flex items-center gap-1 mt-2 text-xs ${isOutbound ? 'text-hud-gold/25' : 'text-hud-cream-dim'}`}>
        <Paperclip size={12} />
        <span>Attachments</span>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1">
      {attachments.map((att) => (
        <button
          key={att.attachmentId}
          onClick={() => onDownload(att.attachmentId, att.filename)}
          disabled={downloadingAttId === att.attachmentId}
          className={`flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
            isOutbound
              ? 'bg-hud-gold-deep/50 hover:bg-hud-gold-deep text-hud-gold/15'
              : 'bg-hud-cream-mute/50 hover:bg-hud-cream-mute text-hud-cream-soft'
          } disabled:opacity-50`}
        >
          <AttachmentIcon mimeType={att.mimeType} />
          <span className="flex-1 truncate">{att.filename}</span>
          <span className="text-[10px] opacity-70 shrink-0">{formatFileSize(att.size)}</span>
          {downloadingAttId === att.attachmentId ? (
            <span className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          ) : (
            <Download size={12} className="shrink-0 opacity-70" />
          )}
        </button>
      ))}
    </div>
  );
}
