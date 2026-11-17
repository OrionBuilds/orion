import { useState } from 'react';
import { X, Tag, Loader2, Plus, Minus } from 'lucide-react';
import type { Tag as TagType } from '../../types';
import { Portal } from '../shared/Portal';

interface BulkTagsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddTag: (tagId: string) => Promise<void>;
  onRemoveTag: (tagId: string) => Promise<void>;
  tags: TagType[];
  selectedCount: number;
  mode: 'add' | 'remove';
}

export function BulkTagsModal({
  isOpen,
  onClose,
  onAddTag,
  onRemoveTag,
  tags,
  selectedCount,
  mode,
}: BulkTagsModalProps) {
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async () => {
    if (!selectedTagId) return;

    setIsLoading(true);
    try {
      if (mode === 'add') {
        await onAddTag(selectedTagId);
      } else {
        await onRemoveTag(selectedTagId);
      }
      onClose();
    } catch (error) {
      console.error(`Failed to ${mode} tag:`, error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const isAdd = mode === 'add';

  return (
    <>
      <Portal><div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} /></Portal>
      <Portal><div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card w-full max-w-md shadow-xl">
          <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  isAdd ? 'bg-hud-emerald/10' : 'bg-hud-plum/10'
                }`}
              >
                {isAdd ? (
                  <Plus className="w-5 h-5 text-hud-emerald" />
                ) : (
                  <Minus className="w-5 h-5 text-hud-plum" />
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {isAdd ? 'Add Tag' : 'Remove Tag'}
                </h2>
                <p className="text-sm text-hud-cream-dim">{selectedCount} contacts selected</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors">
              <X className="w-5 h-5 text-hud-cream-dim" />
            </button>
          </div>

          <div className="p-4">
            <p className="text-sm text-hud-cream-dim mb-4">
              {isAdd
                ? 'Select a tag to add to the selected contacts:'
                : 'Select a tag to remove from the selected contacts:'}
            </p>

            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => setSelectedTagId(tag.id)}
                  className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                    selectedTagId === tag.id
                      ? 'ring-2 ring-offset-2 ring-offset-hud-bg-mid'
                      : 'opacity-60 hover:opacity-100'
                  }`}
                  style={{
                    backgroundColor: `${tag.color}20`,
                    color: tag.color,
                    ...(selectedTagId === tag.id ? { ringColor: tag.color } : {}),
                  }}
                >
                  <Tag className="w-3.5 h-3.5" />
                  {tag.name}
                </button>
              ))}
            </div>

            {tags.length === 0 && (
              <div className="text-center py-8">
                <Tag className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
                <p className="text-sm text-hud-cream-mute">No tags available</p>
                <p className="text-xs text-hud-cream-mute mt-1">Create tags in settings first</p>
              </div>
            )}
          </div>

          <div className="p-4 border-t border-hud-bg-card flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-hud-cream-dim hover:text-white hover:bg-hud-bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isLoading || !selectedTagId}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                isAdd ? 'bg-hud-emerald hover:bg-hud-emerald-dim' : 'bg-hud-plum hover:bg-hud-plum'
              }`}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {isAdd ? 'Adding...' : 'Removing...'}
                </>
              ) : isAdd ? (
                'Add Tag'
              ) : (
                'Remove Tag'
              )}
            </button>
          </div>
        </div>
      </div></Portal>
    </>
  );
}
