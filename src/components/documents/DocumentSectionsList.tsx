import type { ReactNode } from 'react';
import { CreditCard as Edit3, GripVertical, Trash2 } from 'lucide-react';

interface DocumentSection {
  id: string;
  title: string;
  content: string;
  ai_generated: boolean;
  /** Contract sections carry an optional annotation; proposal sections don't. */
  annotation?: string | null;
}

interface DocumentSectionsListProps {
  sections: DocumentSection[];
  editingSectionId: string | null;
  sectionContent: string;
  onSectionContentChange: (value: string) => void;
  onEditClick: (section: DocumentSection) => void;
  onCancelEdit: () => void;
  onSave: (sectionId: string) => void;
  onDelete: (sectionId: string) => void;
  /** Already resolved per page — e.g. Contract additionally requires !isFrozen. */
  canEdit: boolean;
  /** Each document type sanitizes/transforms its content differently before render. */
  renderContent: (content: string) => string;
  emptyState: ReactNode;
}

export function DocumentSectionsList({
  sections,
  editingSectionId,
  sectionContent,
  onSectionContentChange,
  onEditClick,
  onCancelEdit,
  onSave,
  onDelete,
  canEdit,
  renderContent,
  emptyState,
}: DocumentSectionsListProps) {
  if (sections.length === 0) return <>{emptyState}</>;

  return (
    <>
      {sections.map((section) => (
        <div
          key={section.id}
          className="bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-hud-bg-elev flex items-center justify-between">
            <div className="flex items-center gap-3">
              <GripVertical className="w-4 h-4 text-hud-cream-mute" />
              <h3 className="font-medium text-white">{section.title}</h3>
              {section.ai_generated && (
                <span className="px-1.5 py-0.5 bg-hud-gold/20 text-hud-gold-soft rounded text-xs">
                  AI
                </span>
              )}
            </div>
            {canEdit && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onEditClick(section)}
                  className="p-1.5 hover:bg-hud-bg-elev rounded transition-colors"
                >
                  <Edit3 className="w-4 h-4 text-hud-cream-dim" />
                </button>
                <button
                  onClick={() => onDelete(section.id)}
                  className="p-1.5 hover:bg-hud-bg-elev rounded transition-colors"
                >
                  <Trash2 className="w-4 h-4 text-hud-plum" />
                </button>
              </div>
            )}
          </div>
          {section.annotation && (
            <div className="mx-4 mt-3 px-3 py-2 bg-hud-bg-mid/50 border-l-2 border-hud-gold/50 rounded-r-md">
              <p className="text-xs text-hud-cream-dim italic">{section.annotation}</p>
            </div>
          )}
          <div className="p-4">
            {editingSectionId === section.id ? (
              <div className="space-y-3">
                <textarea
                  value={sectionContent}
                  onChange={(e) => onSectionContentChange(e.target.value)}
                  className="w-full h-48 px-4 py-3 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-white resize-none focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={onCancelEdit}
                    className="px-3 py-1.5 text-hud-cream-dim hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => onSave(section.id)}
                    className="px-3 py-1.5 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep rounded-lg transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="proposal-content max-w-none text-sm">
                <div dangerouslySetInnerHTML={{ __html: renderContent(section.content) }} />
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
