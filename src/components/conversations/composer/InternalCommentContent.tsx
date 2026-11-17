import { useState, useRef, useCallback } from 'react';
import { Smile } from 'lucide-react';
import { EntityMentionDropdown } from '../../shared/EntityMentionDropdown';
import { buildMentionToken } from '../../../utils/mentionTokens';
import type { MentionableEntity } from '../../../services/entityMentions';

interface InternalCommentContentProps {
  body: string;
  onBodyChange: (body: string) => void;
  onSend: () => void;
  onClear: () => void;
  sending: boolean;
  sendDisabled: boolean;
  expanded: boolean;
  /** User ids explicitly @mentioned (subset of all entity mentions in `body`) — kept for any future notification fan-out that expects bare user ids. */
  mentions: string[];
  onMentionsChange: (mentions: string[]) => void;
  currentUserId?: string;
  /** Needed to search across contacts/opportunities/projects/proposals/users for the @mention dropdown (A1 entity mentions). */
  orgId?: string;
}

export function InternalCommentContent({
  body,
  onBodyChange,
  onSend,
  onClear,
  sending,
  sendDisabled,
  expanded,
  mentions,
  onMentionsChange,
  currentUserId: _currentUserId,
  orgId,
}: InternalCommentContentProps) {
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleBodyChange = useCallback((value: string) => {
    onBodyChange(value);

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
  }, [onBodyChange]);

  const handleMentionSelect = useCallback((entity: MentionableEntity) => {
    const mentionText = buildMentionToken(entity.type, entity.id, entity.displayName);
    const beforeMention = body.slice(0, mentionStart);
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? body.length;
    const afterMention = body.slice(cursorPos);

    const newBody = beforeMention + mentionText + ' ' + afterMention;
    onBodyChange(newBody);

    // Keep `mentions` as bare user ids only (legacy shape some future
    // notification fan-out may read) — non-user entity mentions live only
    // as tokens in the body, indexed into entity_mentions on send.
    if (entity.type === 'user' && !mentions.includes(entity.id)) {
      onMentionsChange([...mentions, entity.id]);
    }

    setShowMentionDropdown(false);
    setMentionQuery('');
    setMentionStart(-1);

    setTimeout(() => {
      if (textarea) {
        const newCursorPos = beforeMention.length + mentionText.length + 1;
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  }, [body, mentionStart, mentions, onBodyChange, onMentionsChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentionDropdown) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        setShowMentionDropdown(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !showMentionDropdown) {
      e.preventDefault();
      onSend();
    }
  };

  const getDisplayBody = () => {
    return body.replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1');
  };

  return (
    <div className="flex flex-col bg-hud-rust/20">
      <div className="px-4 pt-3 pb-2 relative">
        <textarea
          ref={textareaRef}
          value={getDisplayBody()}
          onChange={(e) => {
            const displayVal = e.target.value;
            let rawVal = displayVal;
            const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g;
            let match;
            while ((match = mentionRegex.exec(body)) !== null) {
              const displayName = `@${match[1]}`;
              if (rawVal.includes(displayName)) {
                rawVal = rawVal.replace(displayName, match[0]);
              }
            }
            handleBodyChange(rawVal);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Write a comment and use @ to mention a contact, opportunity, project, or user. This is not visible to the contact."
          className={`w-full text-sm text-white placeholder-hud-cream-dim resize-y border-none outline-none bg-transparent ${
            expanded ? 'min-h-[200px]' : 'min-h-[100px]'
          }`}
          style={{ maxHeight: expanded ? '400px' : '200px' }}
        />

        {showMentionDropdown && orgId && (
          <EntityMentionDropdown
            query={mentionQuery}
            position={{ top: 40, left: 16 }}
            orgId={orgId}
            onSelect={handleMentionSelect}
            onClose={() => setShowMentionDropdown(false)}
          />
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-hud-rust/30">
        <div className="flex items-center gap-1">
          <button
            className="p-2 text-hud-cream-dim hover:text-hud-rust rounded transition-colors"
            title="Emoji"
          >
            <Smile size={18} />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onClear}
            className="px-4 py-1.5 text-sm text-hud-cream-soft border border-hud-cream-mute rounded-lg hover:bg-hud-bg-elev transition-colors"
          >
            Clear
          </button>
          <button
            onClick={onSend}
            disabled={sendDisabled}
            className="px-6 py-1.5 text-sm font-medium text-white bg-gradient-to-r from-hud-gold to-hud-teal rounded-lg hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mx-2" />
            ) : (
              'Send'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
