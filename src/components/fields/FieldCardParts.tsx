import { Trash2 } from 'lucide-react';
import { EditableText } from '../EditableText';

/**
 * The pieces the form builder's FieldCard and the survey builder's QuestionCard
 * genuinely share.
 *
 * They are NOT collapsed into one component on purpose: the two cards order their
 * contents differently (surveys lead with a Q-number badge and put the label below
 * the icon row; forms put the label inline and wrap the grip in a move-up button),
 * and their placeholder-suppression lists differ. Forcing one component would mean
 * half a dozen boolean props deciding layout — harder to read than the two cards.
 * These are the parts where sharing actually removes duplication.
 */

/** Outer card: selection state, hover affordance, and the remove button. */
export function FieldCardShell({
  isSelected,
  onSelect,
  onRemove,
  grip,
  children,
}: {
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  grip: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-colors ${
        isSelected
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-hud-bg-elev hover:border-hud-cream-mute'
      }`}
    >
      <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity">
        {grip}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="p-1 text-hud-cream-mute hover:text-hud-plum opacity-0 group-hover:opacity-100 reveal-on-touch transition-all"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

/** Explains what a `column` layout field does to the items after it. */
export function ColumnLayoutHint({ count, noun }: { count: number; noun: string }) {
  return (
    <div className="mt-2 p-2 bg-blue-500/10 border border-blue-500/30 rounded text-xs text-blue-300">
      ↓ The next {count} {noun}
      {count === 1 ? '' : 's'} below will share this row side-by-side.
    </div>
  );
}

/** Inline-editable preview of a field's option labels. */
export function FieldOptionsPreview<O extends { label: string }>({
  options,
  onChange,
  keyFor,
}: {
  options: O[];
  onChange: (next: O[]) => void;
  /** Surveys have stable option ids; forms fall back to the index. */
  keyFor: (option: O, index: number) => string | number;
}) {
  if (options.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      {options.map((opt, i) => (
        <div key={keyFor(opt, i)} className="flex items-center gap-2 text-xs text-hud-cream-dim pl-1">
          <span className="w-1 h-1 bg-hud-cream-dim rounded-full shrink-0" />
          <EditableText
            value={opt.label}
            onChange={(next) => {
              const nextOptions = [...options];
              nextOptions[i] = { ...nextOptions[i], label: next };
              onChange(nextOptions);
            }}
            placeholder={`Option ${i + 1}`}
            className="text-hud-cream-dim"
          />
        </div>
      ))}
    </div>
  );
}
