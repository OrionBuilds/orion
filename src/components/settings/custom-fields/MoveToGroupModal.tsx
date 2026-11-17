import { useState } from 'react';
import { X, FolderInput, Loader2 } from 'lucide-react';
import type { CustomField, CustomFieldGroup } from '../../../types';
import { Portal } from '../../shared/Portal';

interface MoveToGroupModalProps {
  field?: CustomField | null;
  fieldCount?: number;
  groups: CustomFieldGroup[];
  currentGroupId: string | null;
  onMove: (groupId: string | null) => Promise<void>;
  onClose: () => void;
}

export function MoveToGroupModal({
  field,
  fieldCount = 1,
  groups,
  currentGroupId,
  onMove,
  onClose,
}: MoveToGroupModalProps) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(currentGroupId);
  const [moving, setMoving] = useState(false);

  const currentGroup = groups.find((g) => g.id === currentGroupId);
  const isBulk = !field && fieldCount > 1;

  async function handleSubmit() {
    if (selectedGroupId === currentGroupId) {
      onClose();
      return;
    }

    setMoving(true);
    try {
      await onMove(selectedGroupId === '' ? null : selectedGroupId);
      onClose();
    } catch (err) {
      console.error('Failed to move field(s):', err);
      alert('Failed to move field(s)');
    } finally {
      setMoving(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-hud-bg-card rounded-xl shadow-xl border border-hud-bg-elev">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-hud-gold/20 rounded-lg">
              <FolderInput className="w-5 h-5 text-hud-gold-soft" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">
                Move {isBulk ? `${fieldCount} Fields` : 'Field'}
              </h2>
              {field && (
                <p className="text-sm text-hud-cream-dim">{field.name}</p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {currentGroup && (
            <div className="mb-4">
              <p className="text-sm text-hud-cream-dim">
                Currently in: <span className="text-white font-medium">{currentGroup.name}</span>
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Select destination group
            </label>
            <select
              value={selectedGroupId || ''}
              onChange={(e) => setSelectedGroupId(e.target.value || null)}
              className="w-full px-3 py-2.5 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-transparent"
            >
              <option value="">No Group (Ungrouped)</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} ({group.fields?.length || 0} fields)
                </option>
              ))}
            </select>
          </div>

          {selectedGroupId !== currentGroupId && selectedGroupId && (
            <div className="mt-4 p-3 bg-hud-gold/10 border border-hud-gold/20 rounded-lg">
              <p className="text-sm text-hud-gold-soft">
                {isBulk ? `${fieldCount} fields` : 'This field'} will be moved to{' '}
                <span className="font-medium">
                  {groups.find((g) => g.id === selectedGroupId)?.name || 'Ungrouped'}
                </span>
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-hud-bg-elev bg-hud-bg-card/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-hud-cream-soft border border-hud-cream-mute rounded-lg hover:bg-hud-bg-elev transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={moving || selectedGroupId === currentGroupId}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-hud-gold to-hud-teal rounded-lg hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {moving && <Loader2 className="w-4 h-4 animate-spin" />}
            {moving ? 'Moving...' : 'Move'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
