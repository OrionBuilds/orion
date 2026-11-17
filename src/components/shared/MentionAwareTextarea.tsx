import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { EntityMentionDropdown } from './EntityMentionDropdown';
import { buildMentionToken, mentionsToPlainText } from '../../utils/mentionTokens';
import type { MentionableEntity } from '../../services/entityMentions';
import type { MentionTargetType } from '../../utils/mentionTokens';

interface MentionAwareTextareaProps {
  /** Raw value, i.e. containing `@[Name](type:id)` tokens. */
  value: string;
  /** Called with the new raw value (tokens included) on every edit. */
  onChange: (value: string) => void;
  orgId: string;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  className?: string;
  onSubmit?: () => void;
  /** Restrict the @ picker to these types (default: everything). */
  allowedTypes?: MentionTargetType[];
}

const MENTION_TOKEN_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Drop-in textarea replacement that shows `@[Name](type:id)` tokens in
 * their plain `@Name` form while typing, and pops an EntityMentionDropdown
 * when the user types `@`. Used by the contact/project/opportunity notes
 * tabs (A1) so notes get the same mention affordance as team chat.
 */
export function MentionAwareTextarea({
  value,
  onChange,
  orgId,
  placeholder,
  rows = 4,
  autoFocus,
  className,
  onSubmit,
  allowedTypes,
}: MentionAwareTextareaProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [query, setQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const detectTrigger = useCallback((raw: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = raw.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex >= 0) {
      const charBefore = atIndex > 0 ? textBeforeCursor[atIndex - 1] : ' ';
      const textAfterAt = textBeforeCursor.slice(atIndex + 1);
      const hasSpace = textAfterAt.includes(' ') && textAfterAt.indexOf(' ') < textAfterAt.length - 1;

      if ((charBefore === ' ' || charBefore === '\n' || atIndex === 0) && !hasSpace) {
        setShowDropdown(true);
        setQuery(textAfterAt);
        setMentionStart(atIndex);
        return;
      }
    }

    setShowDropdown(false);
    setQuery('');
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const displayVal = e.target.value;
    let rawVal = displayVal;
    const re = new RegExp(MENTION_TOKEN_RE);
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      const displayName = `@${match[1]}`;
      if (rawVal.includes(displayName)) {
        rawVal = rawVal.replace(displayName, match[0]);
      }
    }
    onChange(rawVal);
    detectTrigger(rawVal);
  };

  const handleSelect = useCallback((entity: MentionableEntity) => {
    const mentionText = buildMentionToken(entity.type, entity.id, entity.displayName);
    const beforeMention = value.slice(0, mentionStart);
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? value.length;
    const afterMention = value.slice(cursorPos);

    const newValue = beforeMention + mentionText + ' ' + afterMention;
    onChange(newValue);
    setShowDropdown(false);
    setQuery('');
    setMentionStart(-1);

    setTimeout(() => {
      if (textarea) {
        const newCursorPos = beforeMention.length + mentionText.length + 1;
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  }, [value, mentionStart, onChange]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        setShowDropdown(false);
        return;
      }
    }
    if (onSubmit && e.key === 'Enter' && !e.shiftKey && !showDropdown) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={mentionsToPlainText(value)}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        className={
          className ||
          'w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent resize-none'
        }
      />
      {showDropdown && (
        <EntityMentionDropdown
          query={query}
          position={{ top: 0, left: 0 }}
          orgId={orgId}
          allowedTypes={allowedTypes}
          onSelect={handleSelect}
          onClose={() => setShowDropdown(false)}
        />
      )}
    </div>
  );
}
