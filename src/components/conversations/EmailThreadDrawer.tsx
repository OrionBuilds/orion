import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Mail, RefreshCw, AlertTriangle, ArrowLeft, Paperclip, Download, FileText, Image, File, ChevronDown, ChevronUp, Send, Inbox } from 'lucide-react';
import { getGmailThread, downloadAttachment, listMessageAttachments, replyToGmailThread } from '../../services/gmailApi';
import { formatFileSize } from '../../utils/formatters';
import { Portal } from '../shared/Portal';

interface GmailPayloadPart {
  mimeType: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  parts?: GmailPayloadPart[];
}

interface GmailPayload {
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  mimeType?: string;
  parts?: GmailPayloadPart[];
}

interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayload;
  sizeEstimate?: number;
}

interface ParsedThreadMessage {
  id: string;
  messageIdHeader: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  body: string;
  isHtml: boolean;
  isSent: boolean;
  hasAttachments: boolean;
  attachments: { attachmentId: string; filename: string; mimeType: string; size: number }[];
}

interface EmailThreadDrawerProps {
  threadId: string;
  subject: string;
  onClose: () => void;
  conversationId?: string;
  contactId?: string | null;
  /** Fallback reply-to when the latest message has no usable sender. */
  defaultTo?: string;
  /** Called after a reply sends, so the parent conversation can refresh. */
  onSent?: () => void;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
  } catch {
    try {
      return atob(base64);
    } catch {
      return '';
    }
  }
}

function extractBody(payload: GmailPayload): { body: string; isHtml: boolean } {
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    return { body: decoded, isHtml: payload.mimeType === 'text/html' };
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return { body: decodeBase64Url(part.body.data), isHtml: false };
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return { body: decodeBase64Url(part.body.data), isHtml: true };
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith('multipart/') && part.parts) {
        const nested = extractBody({ parts: part.parts } as GmailPayload);
        if (nested.body) return nested;
      }
    }
  }

  return { body: '', isHtml: false };
}

function extractAttachments(parts: GmailPayloadPart[]): ParsedThreadMessage['attachments'] {
  const result: ParsedThreadMessage['attachments'] = [];
  for (const part of parts) {
    if (part.body?.attachmentId && part.filename) {
      result.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      result.push(...extractAttachments(part.parts));
    }
  }
  return result;
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

function parseRawMessage(msg: GmailRawMessage): ParsedThreadMessage {
  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const from = getHeader('From');
  const fromMatch = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?/);
  const fromName = fromMatch?.[1]?.trim() || '';
  const fromEmail = fromMatch?.[2]?.trim() || from.trim();

  const toRaw = getHeader('To');
  const toList = toRaw ? toRaw.split(',').map((s) => s.trim()) : [];

  const ccRaw = getHeader('Cc');
  const ccList = ccRaw ? ccRaw.split(',').map((s) => s.trim()) : [];

  const { body, isHtml } = extractBody(msg.payload || {});
  const attachments = msg.payload?.parts ? extractAttachments(msg.payload.parts) : [];
  const isSent = (msg.labelIds || []).includes('SENT');

  return {
    id: msg.id,
    messageIdHeader: getHeader('Message-ID') || getHeader('Message-Id'),
    from: fromEmail || from,
    fromName,
    to: toList,
    cc: ccList,
    subject: getHeader('Subject'),
    date: getHeader('Date') || (msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : ''),
    body,
    isHtml,
    isSent,
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

export function EmailThreadDrawer({ threadId, subject, onClose, conversationId, contactId, defaultTo, onSent }: EmailThreadDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ParsedThreadMessage[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Reply-to = the newest inbound message's sender (the other party), falling
  // back to the newest message's first recipient, then the conversation contact.
  const replyTarget = (() => {
    const lastInbound = [...messages].reverse().find((m) => !m.isSent);
    const last = messages[messages.length - 1];
    return lastInbound?.from || last?.to?.[0] || defaultTo || '';
  })();
  const lastMessage = messages[messages.length - 1];
  const replySubject = (() => {
    const s = lastMessage?.subject || subject || '';
    return s.toLowerCase().startsWith('re:') ? s : `Re: ${s}`;
  })();

  const handleSendReply = async () => {
    const text = replyBody.trim();
    if (!text) {
      setSendError('Write a reply first.');
      return;
    }
    if (!replyTarget) {
      setSendError('No recipient to reply to.');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const htmlBody = text.replace(/\n/g, '<br>');
      await replyToGmailThread({
        to: replyTarget,
        subject: replySubject,
        htmlBody,
        threadId,
        inReplyTo: lastMessage?.messageIdHeader || undefined,
        references: lastMessage?.messageIdHeader || undefined,
        conversationId,
        contactId: contactId || undefined,
      });
      setReplyBody('');
      setReplyOpen(false);
      await fetchThread();
      onSent?.();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  const fetchThread = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getGmailThread(threadId);
      if (!data?.messages || !Array.isArray(data.messages)) {
        setError('No messages found in this thread.');
        return;
      }

      const parsed = (data.messages as GmailRawMessage[]).map(parseRawMessage);
      setMessages(parsed);

      if (parsed.length > 0) {
        setExpandedIds(new Set([parsed[parsed.length - 1].id]));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load email thread';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    fetchThread();
  }, [fetchThread]);

  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [loading, messages]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Portal><div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative w-[580px] max-w-full h-full bg-hud-bg-card shadow-2xl flex flex-col animate-slide-in-right">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-hud-bg-elev bg-hud-bg-card/95 backdrop-blur-sm">
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-hud-bg-elev rounded-lg transition-colors text-hud-cream-dim hover:text-hud-cream-soft"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-white truncate">
              {subject || 'Email Thread'}
            </h2>
            <p className="text-xs text-hud-cream-dim mt-0.5">
              {messages.length > 0 ? `${messages.length} message${messages.length !== 1 ? 's' : ''}` : 'Loading...'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-hud-bg-elev rounded-lg transition-colors text-hud-cream-dim hover:text-hud-cream-soft"
          >
            <X size={18} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="animate-spin w-8 h-8 border-2 border-hud-gold border-t-transparent rounded-full" />
              <p className="text-sm text-hud-cream-dim">Loading thread...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
              <AlertTriangle className="w-8 h-8 text-hud-rust" />
              <p className="text-sm text-hud-cream-soft text-center">{error}</p>
              <button
                onClick={fetchThread}
                className="flex items-center gap-2 px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft rounded-lg text-sm transition-colors"
              >
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          ) : (
            <div className="p-4 space-y-2">
              {messages.map((msg, idx) => (
                <ThreadMessageCard
                  key={msg.id}
                  message={msg}
                  isLast={idx === messages.length - 1}
                  expanded={expandedIds.has(msg.id)}
                  onToggle={() => toggleExpanded(msg.id)}
                />
              ))}
            </div>
          )}
        </div>

        {!loading && !error && messages.length > 0 && (
          <div className="border-t border-hud-bg-elev bg-hud-bg-card/95 px-4 py-3">
            {!replyOpen ? (
              <button
                onClick={() => { setReplyOpen(true); setSendError(null); }}
                className="flex items-center gap-2 px-3 py-1.5 bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft rounded-lg text-sm transition-colors"
              >
                <Send size={14} />
                Reply{replyTarget ? ` to ${replyTarget}` : ''}
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-hud-cream-dim truncate">
                    To <span className="text-hud-cream-soft">{replyTarget || '—'}</span> · {replySubject}
                  </p>
                  <button
                    onClick={() => { setReplyOpen(false); setSendError(null); }}
                    className="p-1 text-hud-cream-dim hover:text-hud-cream-soft rounded"
                    aria-label="Cancel reply"
                  >
                    <X size={14} />
                  </button>
                </div>
                <textarea
                  value={replyBody}
                  onChange={(e) => { setReplyBody(e.target.value); if (sendError) setSendError(null); }}
                  placeholder="Write your reply…"
                  rows={4}
                  autoFocus
                  className="w-full resize-y rounded-lg bg-hud-bg-elev border border-hud-bg-elev focus:border-hud-gold/50 outline-none px-3 py-2 text-sm text-hud-cream-soft placeholder:text-hud-cream-dim"
                />
                {sendError && (
                  <p className="text-xs text-hud-rust">{sendError}</p>
                )}
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => { setReplyOpen(false); setReplyBody(''); setSendError(null); }}
                    disabled={sending}
                    className="px-3 py-1.5 text-sm text-hud-cream-dim hover:text-hud-cream-soft rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSendReply}
                    disabled={sending}
                    className="flex items-center gap-2 px-3 py-1.5 bg-hud-gold/90 hover:bg-hud-gold text-hud-bg-card font-medium rounded-lg text-sm transition-colors disabled:opacity-60"
                  >
                    {sending ? (
                      <><RefreshCw size={14} className="animate-spin" /> Sending…</>
                    ) : (
                      <><Send size={14} /> Send reply</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div></Portal>
  );
}

function ThreadMessageCard({
  message,
  isLast,
  expanded,
  onToggle,
}: {
  message: ParsedThreadMessage;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);

  const handleDownload = async (attId: string, filename: string) => {
    setDownloadingAttId(attId);
    try {
      const blob = await downloadAttachment(message.id, attId);
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
  };

  const displayBody = message.isHtml ? stripHtml(message.body) : message.body;
  const cleanedBody = displayBody
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const formattedDate = formatThreadDate(message.date);
  const senderInitial = (message.fromName || message.from || '?')[0].toUpperCase();

  return (
    <div className={`rounded-xl border overflow-hidden transition-all duration-200 ${
      message.isSent
        ? 'bg-hud-gold-deep/20 border-hud-gold-deep/40'
        : 'bg-hud-bg-elev border-hud-cream-mute/40'
    }`}>
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-white/[0.03] transition-colors"
      >
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
          message.isSent
            ? 'bg-hud-gold-deep/30 text-hud-gold-soft'
            : 'bg-hud-cream-mute/50 text-hud-cream-soft'
        }`}>
          {message.isSent ? <Send size={14} /> : senderInitial}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">
              {message.isSent ? 'You' : (message.fromName || message.from)}
            </span>
            {message.isSent && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-hud-gold-deep/40 text-hud-gold-soft shrink-0">Sent</span>
            )}
            {!message.isSent && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-hud-cream-mute/40 text-hud-cream-dim shrink-0">
                <Inbox size={10} className="inline -mt-px mr-0.5" />
                Received
              </span>
            )}
          </div>
          {!expanded && (
            <p className="text-xs text-hud-cream-dim truncate mt-0.5">
              {cleanedBody.substring(0, 120) || '(no content)'}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {message.hasAttachments && <Paperclip size={12} className="text-hud-cream-mute" />}
          <span className="text-[11px] text-hud-cream-mute whitespace-nowrap">{formattedDate}</span>
          {expanded ? (
            <ChevronUp size={14} className="text-hud-cream-mute" />
          ) : (
            <ChevronDown size={14} className="text-hud-cream-mute" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-hud-bg-elev/50">
          <div className="px-4 py-2.5 bg-hud-bg-mid/30 space-y-1">
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="text-hud-cream-mute shrink-0">From:</span>
              <span className="text-hud-cream-soft truncate">
                {message.fromName ? `${message.fromName} <${message.from}>` : message.from}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="text-hud-cream-mute shrink-0">To:</span>
              <span className="text-hud-cream-soft truncate">{message.to.join(', ') || '-'}</span>
            </div>
            {message.cc.length > 0 && (
              <div className="flex items-baseline gap-1.5 text-xs">
                <span className="text-hud-cream-mute shrink-0">Cc:</span>
                <span className="text-hud-cream-soft truncate">{message.cc.join(', ')}</span>
              </div>
            )}
            {message.subject && (
              <div className="flex items-baseline gap-1.5 text-xs">
                <span className="text-hud-cream-mute shrink-0">Subject:</span>
                <span className="text-hud-cream-soft truncate">{message.subject}</span>
              </div>
            )}
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="text-hud-cream-mute shrink-0">Date:</span>
              <span className="text-hud-cream-soft">{formatFullDate(message.date)}</span>
            </div>
          </div>

          <div className="px-4 py-3">
            <div className="text-sm text-hud-cream-soft whitespace-pre-wrap break-words leading-relaxed max-h-[400px] overflow-y-auto">
              {cleanedBody || '(no content)'}
            </div>
          </div>

          {message.hasAttachments && message.attachments.length > 0 && (
            <div className="px-4 pb-3 space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-hud-cream-mute mb-1.5">
                <Paperclip size={11} />
                <span>{message.attachments.length} attachment{message.attachments.length !== 1 ? 's' : ''}</span>
              </div>
              {message.attachments.map((att) => (
                <button
                  key={att.attachmentId}
                  onClick={() => handleDownload(att.attachmentId, att.filename)}
                  disabled={downloadingAttId === att.attachmentId}
                  className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg text-xs bg-hud-bg-elev/40 hover:bg-hud-bg-elev text-hud-cream-soft transition-colors disabled:opacity-50"
                >
                  <AttachmentIcon mimeType={att.mimeType} />
                  <span className="flex-1 truncate">{att.filename}</span>
                  <span className="text-[10px] text-hud-cream-mute shrink-0">{formatFileSize(att.size)}</span>
                  {downloadingAttId === att.attachmentId ? (
                    <span className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full shrink-0" />
                  ) : (
                    <Download size={12} className="shrink-0 text-hud-cream-mute" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AttachmentIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <Image size={14} className="shrink-0" />;
  if (mimeType === 'application/pdf') return <FileText size={14} className="shrink-0" />;
  return <File size={14} className="shrink-0" />;
}
function formatThreadDate(dateString: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (isYesterday) {
    return 'Yesterday';
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatFullDate(dateString: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
