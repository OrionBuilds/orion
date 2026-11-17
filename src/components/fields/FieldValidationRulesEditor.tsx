import { X } from 'lucide-react';
import type { FormValidationRule } from '../../types';
import { availableValidationRules, type BaseFieldConfig, type FieldUpdate } from './types';

/**
 * Validation rule editor shared by the form and survey builders.
 *
 * The two were byte-identical apart from the parameter name and the type list —
 * and the survey copy had drifted, omitting `source` from the text-like bucket, so
 * a survey source question could not take validation rules a form source field could.
 * The shared rule table in ./types fixes that as a side effect.
 */
export function FieldValidationRulesEditor<T extends BaseFieldConfig>({
  field,
  onUpdate,
  noun = 'field',
}: {
  field: T;
  onUpdate: (updates: FieldUpdate) => void;
  /** Used only in the empty state — "field" or "question". */
  noun?: string;
}) {
  const rules = field.validationRules || [];
  const availableRules = availableValidationRules(field.type);

  function addRule(type: FormValidationRule['type']) {
    onUpdate({ validationRules: [...rules, { type, value: '' }] });
  }

  function updateRule(index: number, updates: Partial<FormValidationRule>) {
    const newRules = [...rules];
    newRules[index] = { ...newRules[index], ...updates };
    onUpdate({ validationRules: newRules });
  }

  function removeRule(index: number) {
    onUpdate({ validationRules: rules.filter((_, i) => i !== index) });
  }

  if (availableRules.length === 0) {
    return (
      <div className="text-center py-6 bg-hud-bg-card/50 rounded-lg">
        <p className="text-sm text-hud-cream-dim">
          No validation rules available for this {noun} type
        </p>
      </div>
    );
  }

  const unused = availableRules.filter((r) => !rules.some((rule) => rule.type === r.type));

  return (
    <div className="space-y-4">
      {rules.map((rule, idx) => (
        <div key={idx} className="p-3 bg-hud-bg-card/50 rounded-lg space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-hud-cream-soft">
              {availableRules.find((r) => r.type === rule.type)?.label}
            </span>
            <button onClick={() => removeRule(idx)} className="p-1 text-hud-cream-mute hover:text-hud-plum">
              <X className="w-4 h-4" />
            </button>
          </div>
          {rule.type !== 'format' && (
            <input
              type={
                rule.type === 'pattern'
                  ? 'text'
                  : rule.type === 'min_date' || rule.type === 'max_date'
                  ? 'date'
                  : 'number'
              }
              value={rule.value}
              onChange={(e) =>
                updateRule(idx, {
                  value:
                    rule.type === 'pattern' || rule.type === 'min_date' || rule.type === 'max_date'
                      ? e.target.value
                      : parseFloat(e.target.value),
                })
              }
              placeholder={rule.type === 'pattern' ? '^[a-zA-Z]+$' : '0'}
              className="w-full px-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          {rule.type === 'format' && (
            <p className="text-xs text-hud-cream-dim italic">Built-in format check (no value needed).</p>
          )}
          <input
            type="text"
            value={rule.message || ''}
            onChange={(e) => updateRule(idx, { message: e.target.value })}
            placeholder="Custom error message (optional)"
            className="w-full px-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      ))}

      {unused.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1">Add Rule</label>
          <select
            value=""
            onChange={(e) => e.target.value && addRule(e.target.value as FormValidationRule['type'])}
            className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select rule type...</option>
            {unused.map((r) => (
              <option key={r.type} value={r.type}>{r.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
