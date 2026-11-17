import { useState, useEffect, useRef, useCallback } from 'react';
import { User as UserIcon, Users, Target, FolderKanban, FileText, File } from 'lucide-react';
import { searchMentionableEntities, type MentionableEntity } from '../../services/entityMentions';
import type { MentionTargetType } from '../../utils/mentionTokens';

const TYPE_ICON: Record<MentionTargetType, typeof UserIcon> = {
  user: UserIcon,
  contact: Users,
  opportunity: Target,
  project: FolderKanban,
  proposal: FileText,
  document: File,
};

const TYPE_LABEL: Record<MentionTargetType, string> = {
  user: 'User',
  contact: 'Contact',
  opportunity: 'Opportunity',
  project: 'Project',
  proposal: 'Proposal',
  document: 'Document',
};

interface EntityMentionDropdownProps {
  query: string;
  position: { top: number; left: number };
  orgId: string;
  onSelect: (entity: MentionableEntity) => void;
  onClose: () => void;
  /** Restrict results to a subset of types (default: all). */
  allowedTypes?: MentionTargetType[];
}

/**
 * Generalized @mention autocomplete — searches contacts, opportunities,
 * projects, proposals, documents, and users in parallel via
 * searchMentionableEntities(). Drop-in successor to the users-only
 * MentionDropdown (composer/MentionDropdown.tsx), kept for the internal
 * conversation-comment surface which still only needs user mentions.
 */
export function EntityMentionDropdown({
  query,
  position,
  orgId,
  onSelect,
  onClose,
  allowedTypes,
}: EntityMentionDropdownProps) {
  const [results, setResults] = useState<MentionableEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const entities = await searchMentionableEntities(query, orgId, 5, allowedTypes);
        const filtered = allowedTypes
          ? entities.filter((e) => allowedTypes.includes(e.type))
          : entities;
        setResults(filtered.slice(0, 8));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, orgId, allowedTypes]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (results[selectedIndex]) {
          onSelect(results[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [results, selectedIndex, onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (!query.trim()) return null;
  if (!loading && results.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bg-hud-bg-card border border-hud-cream-mute rounded-lg shadow-lg z-50 w-72 max-h-64 overflow-y-auto"
      style={{ bottom: position.top, left: position.left }}
    >
      {loading && results.length === 0 ? (
        <div className="px-3 py-2 text-xs text-hud-cream-mute">Searching…</div>
      ) : (
        results.map((entity, index) => {
          const Icon = TYPE_ICON[entity.type];
          return (
            <button
              key={`${entity.type}-${entity.id}`}
              onClick={() => onSelect(entity)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                index === selectedIndex ? 'bg-hud-gold/20' : 'hover:bg-hud-bg-elev'
              }`}
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal text-white flex items-center justify-center shrink-0">
                <Icon className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-white truncate">{entity.displayName}</div>
                <div className="text-hud-cream-mute text-xs truncate">
                  {TYPE_LABEL[entity.type]}
                  {entity.subtitle && entity.type !== 'opportunity' && entity.type !== 'project' && entity.type !== 'proposal'
                    ? ` · ${entity.subtitle}`
                    : ''}
                </div>
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}
