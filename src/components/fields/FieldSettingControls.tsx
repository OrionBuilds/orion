import type { BaseFieldConfig, FieldUpdate } from './types';

/**
 * Per-property setting controls shared by the form and survey field editors.
 *
 * FieldEditor and QuestionEditor are both a long series of
 * `{typeMatches && (<one setting block>)}`, and 68% of the form editor's
 * substantive lines were identical to the survey editor's. Each block edits
 * exactly one BaseFieldConfig property, so each becomes one control here and both
 * editors keep their own type predicates — the conditions differ (forms say
 * `text`, surveys say `short_answer`) even where the control is the same.
 */

const INPUT =
  'w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500';
const CHECKBOX = 'mt-0.5 rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500';
const LABEL = 'block text-sm font-medium text-hud-cream-soft mb-1';
const HINT = 'text-xs text-hud-cream-dim mt-1';

type Update = (updates: FieldUpdate) => void;

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  );
}

function CheckboxRow({
  checked,
  onChange,
  title,
  hint,
  indented,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: React.ReactNode;
  hint?: string;
  indented?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 text-sm text-hud-cream-soft${indented ? ' ml-5' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={CHECKBOX}
      />
      <span>
        {title}
        {hint && <span className="block text-xs text-hud-cream-dim mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

export function CurrencySetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Currency">
      <input
        type="text"
        value={field.currency || 'USD'}
        onChange={(e) => onUpdate({ currency: e.target.value.toUpperCase() })}
        maxLength={3}
        className={INPUT}
      />
    </Labelled>
  );
}

export function HtmlContentSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="HTML Content" hint="Rendered as-is on the public page. Sanitize untrusted content.">
      <textarea
        value={field.htmlContent || ''}
        onChange={(e) => onUpdate({ htmlContent: e.target.value })}
        rows={6}
        placeholder="<p>Custom HTML content</p>"
        className="w-full px-3 py-2 font-mono text-xs border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </Labelled>
  );
}

export function ColumnCountSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Columns">
      <select
        value={field.columnCount || 2}
        onChange={(e) => onUpdate({ columnCount: parseInt(e.target.value) as 2 | 3 | 4 })}
        className={INPUT}
      >
        <option value={2}>2 columns</option>
        <option value={3}>3 columns</option>
        <option value={4}>4 columns</option>
      </select>
    </Labelled>
  );
}

export function HeadingLevelSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled
      label="Heading Level"
      hint="The Label above is the heading text. Inline-edit it on the canvas."
    >
      <select
        value={field.headingLevel || 'h2'}
        onChange={(e) => onUpdate({ headingLevel: e.target.value as 'h1' | 'h2' | 'h3' | 'h4' })}
        className={INPUT}
      >
        <option value="h1">H1 (largest)</option>
        <option value="h2">H2</option>
        <option value="h3">H3</option>
        <option value="h4">H4 (smallest)</option>
      </select>
    </Labelled>
  );
}

export function CharacterLimitSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Character Limit">
      <input
        type="number"
        value={field.characterLimit || ''}
        onChange={(e) =>
          onUpdate({ characterLimit: e.target.value ? parseInt(e.target.value) : undefined })
        }
        placeholder="No limit"
        className={INPUT}
      />
    </Labelled>
  );
}

export function PhoneFormatSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Phone Format">
      <select
        value={field.phoneFormat || 'us'}
        onChange={(e) => onUpdate({ phoneFormat: e.target.value as 'us' | 'international' })}
        className={INPUT}
      >
        <option value="us">US (xxx) xxx-xxxx</option>
        <option value="international">International with country code</option>
      </select>
    </Labelled>
  );
}

export function EmailDeliverabilitySetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <CheckboxRow
      checked={field.validateDeliverability || false}
      onChange={(validateDeliverability) => onUpdate({ validateDeliverability })}
      title="Validate email deliverability"
      hint="Performs an MX/SMTP check (requires email-validation provider)."
    />
  );
}

export function AddressSettings({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <div className="space-y-3 p-3 bg-hud-bg-card/50 rounded-lg">
      <div className="text-xs font-medium text-hud-cream-soft">Address Settings</div>
      <CheckboxRow
        checked={field.addressAutoComplete || false}
        onChange={(addressAutoComplete) => onUpdate({ addressAutoComplete })}
        title="Enable address auto-complete"
        hint="Wired to Google Places (coming soon)"
      />
      {field.addressAutoComplete && (
        <CheckboxRow
          indented
          checked={field.addressMandatorySelect || false}
          onChange={(addressMandatorySelect) => onUpdate({ addressMandatorySelect })}
          title="Require selecting an address from the dropdown"
        />
      )}
    </div>
  );
}

export function AllowOtherSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <CheckboxRow
      checked={field.allowOther || false}
      onChange={(allowOther) => onUpdate({ allowOther })}
      title={'Allow "Other" option'}
      hint="Adds an Other choice that reveals a free-text input."
    />
  );
}

export function SelectionLimitsSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Labelled label="Min selections">
        <input
          type="number"
          min={0}
          value={field.minSelections ?? ''}
          onChange={(e) =>
            onUpdate({ minSelections: e.target.value ? parseInt(e.target.value) : undefined })
          }
          placeholder="0"
          className={INPUT}
        />
      </Labelled>
      <Labelled label="Max selections">
        <input
          type="number"
          min={1}
          value={field.maxSelections ?? ''}
          onChange={(e) =>
            onUpdate({ maxSelections: e.target.value ? parseInt(e.target.value) : undefined })
          }
          placeholder="No limit"
          className={INPUT}
        />
      </Labelled>
    </div>
  );
}

export function ConsentDescriptionSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled
      label="Description (HTML allowed)"
      hint="Label stays plain text (matches GHL constraint). Description renders as HTML for links."
    >
      <textarea
        value={field.consentDescription || ''}
        onChange={(e) => onUpdate({ consentDescription: e.target.value })}
        rows={3}
        placeholder='I agree to the &lt;a href="/terms"&gt;Terms of Service&lt;/a&gt;'
        className="w-full px-3 py-2 text-xs font-mono border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </Labelled>
  );
}

export function LabelAlignmentSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Label Alignment">
      <select
        value={field.labelAlignment || 'top'}
        onChange={(e) => onUpdate({ labelAlignment: e.target.value as 'top' | 'left' | 'inline' })}
        className={INPUT}
      >
        <option value="top">Top</option>
        <option value="left">Left</option>
        <option value="inline">Inline (hide label, use placeholder)</option>
      </select>
    </Labelled>
  );
}

export function OptionsLayoutSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Options Layout">
      <select
        value={field.optionsLayout || 'vertical'}
        onChange={(e) =>
          onUpdate({
            optionsLayout: e.target.value as 'vertical' | 'horizontal' | 'columns_2' | 'columns_3',
          })
        }
        className={INPUT}
      >
        <option value="vertical">Vertical</option>
        <option value="horizontal">Horizontal</option>
        <option value="columns_2">2 columns</option>
        <option value="columns_3">3 columns</option>
      </select>
    </Labelled>
  );
}

export function CustomClassNameSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Custom CSS Class">
      <input
        type="text"
        value={field.customClassName || ''}
        onChange={(e) => onUpdate({ customClassName: e.target.value })}
        placeholder="my-custom-class"
        className={INPUT}
      />
    </Labelled>
  );
}

export function SignaturePadHeightSetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled label="Signature pad height (px)">
      <input
        type="number"
        min={80}
        value={field.signaturePadHeight ?? ''}
        onChange={(e) =>
          onUpdate({ signaturePadHeight: e.target.value ? parseInt(e.target.value) : undefined })
        }
        placeholder="160"
        className={INPUT}
      />
    </Labelled>
  );
}

export function HiddenParamKeySetting({ field, onUpdate }: { field: BaseFieldConfig; onUpdate: Update }) {
  return (
    <Labelled
      label="URL parameter key"
      hint="Populated from ?key=value on the public page."
    >
      <input
        type="text"
        value={field.hiddenParamKey || ''}
        onChange={(e) => onUpdate({ hiddenParamKey: e.target.value })}
        placeholder="utm_source"
        className={INPUT}
      />
    </Labelled>
  );
}

/**
 * Formula editor for calculated fields, with a picker of the numeric siblings that
 * can be referenced.
 */
export function FormulaSetting<T extends BaseFieldConfig>({
  field,
  onUpdate,
  siblings,
  noun = 'field',
}: {
  field: BaseFieldConfig;
  onUpdate: Update;
  /**
   * Optional. The form builder has the sibling list in scope and renders a click-to-insert
   * picker of referenceable ids; the survey builder never had one (QuestionEditor is not
   * given the other questions), so it omits this and gets the plain input it always had.
   */
  siblings?: T[];
  noun?: string;
}) {
  const numeric = (siblings ?? []).filter(
    (f) =>
      f.id !== field.id &&
      (f.type === 'number' || f.type === 'monetary' || f.type === 'math_calculation')
  );

  return (
    <Labelled
      label="Formula"
      hint={<>Reference other {noun}s with {'{' + noun + '-id}'}. Supported: + - * / ( ).</>}
    >
      <input
        type="text"
        value={field.formula || ''}
        onChange={(e) => onUpdate({ formula: e.target.value })}
        placeholder="e.g. {sqft} * 12 + 250"
        className="w-full px-3 py-2 font-mono text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {numeric.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-blue-400 hover:text-blue-300">
            Available {noun} IDs (Number / Monetary only)
          </summary>
          <div className="mt-1 space-y-0.5 max-h-32 overflow-y-auto bg-hud-bg-card/50 rounded p-2">
            {numeric.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onUpdate({ formula: (field.formula || '') + `{${f.id}}` })}
                className="block w-full text-left font-mono hover:bg-blue-500/10 px-1 py-0.5 rounded"
              >
                <span className="text-hud-cream-dim">{`{${f.id}}`}</span>
                <span className="text-hud-cream-soft ml-2">{f.label}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </Labelled>
  );
}
