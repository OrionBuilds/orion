import type { BaseFieldConfig, FieldUpdate } from './types';

const INPUT_CLS =
  'w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500';

/** Types where a default is numeric. Survey-only types (rating, nps) are harmless on forms. */
const NUMERIC = new Set(['number', 'monetary', 'rating', 'nps']);
/** Multi-line text: forms call it textarea, surveys call it long_answer. */
const MULTILINE = new Set(['textarea', 'long_answer']);
/** Single-choice from a fixed option list. */
const SINGLE_CHOICE = new Set(['dropdown', 'radio', 'multiple_choice']);
const BOOLEAN = new Set(['checkbox', 'consent']);
/**
 * Types where a default value is meaningless. The survey builder already suppressed
 * these; the form builder fell through to a plain text box, so form editors were
 * offered a "Default Value" for signature and file-upload fields that could never
 * do anything. Suppressing on both is the correct behaviour.
 */
const NO_DEFAULT = new Set([
  'matrix',
  'image_choice',
  'multi_select',
  'ranking',
  'file_upload',
  'signature',
]);

export function FieldDefaultValueInput<T extends BaseFieldConfig>({
  field,
  onUpdate,
  options,
  noun = 'field',
}: {
  field: T;
  onUpdate: (updates: FieldUpdate) => void;
  /** Passed explicitly: form and survey option shapes differ, but both carry label+value. */
  options?: { label: string; value: string }[];
  noun?: string;
}) {
  const value = field.defaultValue ?? '';
  const type = field.type;

  if (NO_DEFAULT.has(type)) return null;

  let input: React.ReactNode;

  if (NUMERIC.has(type)) {
    input = (
      <input
        type="number"
        value={value}
        onChange={(e) => onUpdate({ defaultValue: e.target.value })}
        className={INPUT_CLS}
      />
    );
  } else if (type === 'date') {
    input = (
      <input
        type="date"
        value={value}
        onChange={(e) => onUpdate({ defaultValue: e.target.value })}
        className={INPUT_CLS}
      />
    );
  } else if (MULTILINE.has(type)) {
    input = (
      <textarea
        rows={2}
        value={value}
        onChange={(e) => onUpdate({ defaultValue: e.target.value })}
        className={INPUT_CLS}
      />
    );
  } else if (SINGLE_CHOICE.has(type)) {
    input = (
      <select
        value={value}
        onChange={(e) => onUpdate({ defaultValue: e.target.value })}
        className={INPUT_CLS}
      >
        <option value="">— None —</option>
        {(options || []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (BOOLEAN.has(type)) {
    input = (
      <label className="flex items-center gap-2 text-sm text-hud-cream-soft">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onUpdate({ defaultValue: e.target.checked ? 'true' : '' })}
          className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
        />
        Pre-checked by default
      </label>
    );
  } else {
    input = (
      <input
        type="text"
        value={value}
        onChange={(e) => onUpdate({ defaultValue: e.target.value })}
        className={INPUT_CLS}
      />
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium text-hud-cream-soft mb-1">Default Value</label>
      {input}
      <p className="text-xs text-hud-cream-dim mt-1">Pre-fills the {noun} on load.</p>
    </div>
  );
}
