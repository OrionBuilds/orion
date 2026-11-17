import { useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';

interface OptionListEditorProps {
  options: string[];
  onChange: (options: string[]) => void;
  defaultValue?: string;
  onDefaultValueChange?: (value: string) => void;
  disabled?: boolean;
}

export function OptionListEditor({
  options,
  onChange,
  defaultValue,
  onDefaultValueChange,
  disabled = false,
}: OptionListEditorProps) {
  const [newOption, setNewOption] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  function handleAddOption() {
    const trimmed = newOption.trim();
    if (trimmed && !options.includes(trimmed)) {
      onChange([...options, trimmed]);
      setNewOption('');
    }
  }

  function handleRemoveOption(index: number) {
    const removed = options[index];
    const newOptions = options.filter((_, i) => i !== index);
    onChange(newOptions);
    if (defaultValue === removed && onDefaultValueChange) {
      onDefaultValueChange('');
    }
  }

  function handleOptionChange(index: number, value: string) {
    const oldValue = options[index];
    const newOptions = [...options];
    newOptions[index] = value;
    onChange(newOptions);
    if (defaultValue === oldValue && onDefaultValueChange) {
      onDefaultValueChange(value);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddOption();
    }
  }

  function handleDragStart(index: number) {
    setDraggedIndex(index);
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newOptions = [...options];
    const [dragged] = newOptions.splice(draggedIndex, 1);
    newOptions.splice(index, 0, dragged);
    onChange(newOptions);
    setDraggedIndex(index);
  }

  function handleDragEnd() {
    setDraggedIndex(null);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {options.map((option, index) => (
          <div
            key={index}
            draggable={!disabled}
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={handleDragEnd}
            className={`
              flex items-center gap-2 group
              ${draggedIndex === index ? 'opacity-50' : ''}
            `}
          >
            <div className={`
              p-1.5 text-hud-cream-mute cursor-grab active:cursor-grabbing
              ${disabled ? 'cursor-not-allowed opacity-50' : ''}
            `}>
              <GripVertical className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={option}
              onChange={(e) => handleOptionChange(index, e.target.value)}
              disabled={disabled}
              className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white text-sm focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              onClick={() => handleRemoveOption(index)}
              disabled={disabled}
              className="p-2 text-hud-cream-mute hover:text-hud-plum hover:bg-hud-plum/10 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="w-8" />
        <input
          type="text"
          value={newOption}
          onChange={(e) => setNewOption(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Add new option..."
          className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-cream-mute border-dashed rounded-lg text-white text-sm placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={handleAddOption}
          disabled={disabled || !newOption.trim()}
          className="p-2 text-hud-cream-dim hover:text-hud-gold-soft hover:bg-hud-gold/10 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {onDefaultValueChange && options.length > 0 && (
        <div className="pt-3 border-t border-hud-bg-elev">
          <label className="block text-sm font-medium text-hud-cream-dim mb-2">
            Default Value
          </label>
          <select
            value={defaultValue || ''}
            onChange={(e) => onDefaultValueChange(e.target.value)}
            disabled={disabled}
            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white text-sm focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">No default</option>
            {options.map((option, index) => (
              <option key={index} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      )}

      {options.length === 0 && (
        <p className="text-sm text-hud-cream-mute text-center py-4">
          No options yet. Add at least one option above.
        </p>
      )}
    </div>
  );
}
