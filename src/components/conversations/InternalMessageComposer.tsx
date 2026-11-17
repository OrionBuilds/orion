import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import { Send, Paperclip, X, FileText, Film, Music, Archive, File, AlertCircle, Loader2, Mic, Square } from 'lucide-react';
import { useSpeechInput } from '../../hooks/useSpeechInput';
import {
  type TeamAttachment,
  TEAM_ATTACHMENT_MAX_SIZE,
  TEAM_ATTACHMENT_MAX_FILES,
  uploadTeamAttachment,
} from '../../services/teamMessaging';
import { useAuth } from '../../contexts/AuthContext';
import { EntityMentionDropdown } from '../shared/EntityMentionDropdown';
import { buildMentionToken } from '../../utils/mentionTokens';
import type { MentionableEntity } from '../../services/entityMentions';
import { formatFileSize } from '../../utils/formatters';

interface InternalMessageComposerProps {
  onSendMessage: (content: string, attachments?: TeamAttachment[]) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  /** Put text in the box (and focus it): quick-prompt chips that need finishing, like "Email ...". New nonce = new fill. */
  prefill?: { text: string; nonce: number } | null;
}
function getFileIcon(type: string) {
  if (type.startsWith('image/')) return null;
  if (type.startsWith('video/')) return Film;
  if (type.startsWith('audio/')) return Music;
  if (type === 'application/pdf') return FileText;
  if (type.includes('zip') || type.includes('rar') || type.includes('gzip')) return Archive;
  return File;
}

export function InternalMessageComposer({
  onSendMessage,
  disabled = false,
  placeholder = 'Type a message...',
  prefill = null,
}: InternalMessageComposerProps) {
  const { user: authUser } = useAuth();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasContent = message.trim().length > 0 || selectedFiles.length > 0;

  const messageRef = useRef('');
  messageRef.current = message;
  const dictation = useSpeechInput(useCallback(() => messageRef.current, []), setMessage);

  useEffect(() => {
    if (!prefill) return;
    setMessage(prefill.text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(prefill.text.length, prefill.text.length);
    });
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async () => {
    if (!hasContent || sending || disabled || uploading) return;

    try {
      setSending(true);
      let attachments: TeamAttachment[] | undefined;

      if (selectedFiles.length > 0) {
        const orgId = authUser?.organization_id;
        if (!orgId) throw new Error('Organization not found');

        setUploading(true);
        attachments = await Promise.all(
          selectedFiles.map((file) => uploadTeamAttachment(file, orgId))
        );
        setUploading(false);
      }

      await onSendMessage(message.trim(), attachments);
      setMessage('');
      setSelectedFiles([]);
      setFileError(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      setUploading(false);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionDropdown && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
      e.preventDefault();
      return;
    }
    if (showMentionDropdown && e.key === 'Escape') {
      setShowMentionDropdown(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !showMentionDropdown) {
      e.preventDefault();
      handleSend();
    }
  };

  const detectMentionTrigger = useCallback((value: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex >= 0) {
      const charBefore = atIndex > 0 ? textBeforeCursor[atIndex - 1] : ' ';
      const textAfterAt = textBeforeCursor.slice(atIndex + 1);
      const hasSpace = textAfterAt.includes(' ') && textAfterAt.indexOf(' ') < textAfterAt.length - 1;

      if ((charBefore === ' ' || charBefore === '\n' || atIndex === 0) && !hasSpace) {
        setShowMentionDropdown(true);
        setMentionQuery(textAfterAt);
        setMentionStart(atIndex);
        return;
      }
    }

    setShowMentionDropdown(false);
    setMentionQuery('');
  }, []);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // The textarea shows the plain `@Name` form; reconstruct the raw
    // `@[Name](type:id)` tokens the underlying edit corresponds to (same
    // approach as InternalCommentContent.tsx's user-only mention editing).
    const displayVal = e.target.value;
    let rawVal = displayVal;
    const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(message)) !== null) {
      const displayName = `@${match[1]}`;
      if (rawVal.includes(displayName)) {
        rawVal = rawVal.replace(displayName, match[0]);
      }
    }

    setMessage(rawVal);
    e.target.style.height = 'auto';
    const newHeight = Math.min(e.target.scrollHeight, 150);
    e.target.style.height = `${newHeight}px`;
    detectMentionTrigger(rawVal);
  };

  const handleMentionSelect = useCallback((entity: MentionableEntity) => {
    const mentionText = buildMentionToken(entity.type, entity.id, entity.displayName);
    const beforeMention = message.slice(0, mentionStart);
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? message.length;
    const afterMention = message.slice(cursorPos);

    const newMessage = beforeMention + mentionText + ' ' + afterMention;
    setMessage(newMessage);
    setShowMentionDropdown(false);
    setMentionQuery('');
    setMentionStart(-1);

    setTimeout(() => {
      if (textarea) {
        const newCursorPos = beforeMention.length + mentionText.length + 1;
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
      }
    }, 0);
  }, [message, mentionStart]);

  const getDisplayMessage = () => message.replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1');

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    setFileError(null);

    const totalCount = selectedFiles.length + files.length;
    if (totalCount > TEAM_ATTACHMENT_MAX_FILES) {
      setFileError(`Maximum ${TEAM_ATTACHMENT_MAX_FILES} files allowed`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const oversized = files.find((f) => f.size > TEAM_ATTACHMENT_MAX_SIZE);
    if (oversized) {
      setFileError(`"${oversized.name}" exceeds 100 MB limit`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setSelectedFiles((prev) => [...prev, ...files]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setFileError(null);
  };

  return (
    <div className="border-t border-hud-bg-elev bg-hud-bg-card">
      {selectedFiles.length > 0 && (
        <div className="px-4 pt-3 flex flex-wrap gap-2">
          {selectedFiles.map((file, i) => {
            const isImage = file.type.startsWith('image/');
            const Icon = getFileIcon(file.type);

            return (
              <div
                key={`${file.name}-${i}`}
                className="relative group flex items-center gap-2 bg-hud-bg-elev rounded-lg border border-hud-cream-mute overflow-hidden"
              >
                {isImage ? (
                  <img
                    src={URL.createObjectURL(file)}
                    alt={file.name}
                    className="w-16 h-16 object-cover"
                  />
                ) : (
                  <div className="w-16 h-16 flex items-center justify-center bg-hud-cream-mute">
                    {Icon && <Icon size={24} className="text-hud-cream-soft" />}
                  </div>
                )}
                <div className="pr-8 py-1.5 max-w-[140px]">
                  <p className="text-xs text-white font-medium truncate">{file.name}</p>
                  <p className="text-xs text-hud-cream-dim">{formatFileSize(file.size)}</p>
                </div>
                <button
                  onClick={() => removeFile(i)}
                  className="absolute top-1 right-1 p-0.5 rounded-full bg-hud-bg-mid/70 hover:bg-hud-plum text-hud-cream-soft hover:text-white transition-colors opacity-0 group-hover:opacity-100 reveal-on-touch"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {fileError && (
        <div className="mx-4 mt-2 flex items-center gap-1.5 text-xs text-hud-plum">
          <AlertCircle size={12} />
          {fileError}
        </div>
      )}

      <div className="p-4">
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-lg bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft hover:text-white transition-colors flex-shrink-0"
            title="Attach file"
            disabled={disabled || sending}
          >
            <Paperclip size={20} />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            accept="image/*,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/ogg,audio/wav,audio/webm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,application/zip"
          />

          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={getDisplayMessage()}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={selectedFiles.length > 0 ? 'Add a message (optional)' : placeholder}
              disabled={disabled || sending}
              className="w-full px-4 py-2.5 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none min-h-[44px] max-h-[150px]"
              rows={1}
            />
            {showMentionDropdown && authUser?.organization_id && (
              <EntityMentionDropdown
                query={mentionQuery}
                position={{ top: 48, left: 0 }}
                orgId={authUser.organization_id}
                onSelect={handleMentionSelect}
                onClose={() => setShowMentionDropdown(false)}
              />
            )}
          </div>

          {dictation.supported && (
            <button
              type="button"
              onClick={dictation.listening ? dictation.stop : dictation.start}
              disabled={disabled || sending}
              aria-label={dictation.listening ? 'Stop dictation' : 'Dictate a message'}
              aria-pressed={dictation.listening}
              className={`p-2 rounded-lg transition-colors flex-shrink-0 ${dictation.listening ? 'bg-hud-plum text-white animate-pulse' : 'bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft hover:text-white'}`}
              title={dictation.listening ? 'Stop dictation' : 'Dictate'}
            >
              {dictation.listening ? <Square size={20} /> : <Mic size={20} />}
            </button>
          )}

          <button
            onClick={handleSend}
            disabled={!hasContent || sending || disabled}
            className="p-2 rounded-lg bg-hud-gold-deep hover:bg-hud-gold-deep text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            title="Send message"
          >
            {uploading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <Send size={20} />
            )}
          </button>
        </div>

        {dictation.error && <p className="text-xs text-hud-plum mt-2">{dictation.error}</p>}
        <p className="text-xs text-hud-cream-mute mt-2 hidden sm:block">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
