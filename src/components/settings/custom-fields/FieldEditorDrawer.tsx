import { useState, useEffect } from 'react';
import { X, ChevronDown, ChevronRight, AlertCircle, HelpCircle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import type {
  CustomField,
  CustomFieldGroup,
  CustomFieldScope,
  CustomFieldType,
  CreateCustomFieldInput,
} from '../../../types';
import { SAFE_TYPE_MIGRATIONS } from '../../../types';
import {
  createCustomField,
  updateCustomField,
  generateFieldKey,
  getFieldValueCount,
  canMigrateFieldType,
} from '../../../services/customFields';
import { FieldTypeSelector } from './FieldTypeSelector';
import { OptionListEditor } from './OptionListEditor';
import { Portal } from '../../shared/Portal';

interface FieldEditorDrawerProps {
  scope: CustomFieldScope;
  field: CustomField | null;
  groups: CustomFieldGroup[];
  onClose: () => void;
  onSaved: () => void;
}

interface SectionProps {
  title: string;
  number: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({ title, number, expanded, onToggle, children }: SectionProps) {
  return (
    <div className="border border-hud-bg-elev rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 bg-hud-bg-card hover:bg-hud-bg-elev/50 transition-colors"
      >
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-hud-gold/20 text-hud-gold-soft text-sm font-medium">
          {number}
        </span>
        <span className="flex-1 text-left font-medium text-white">{title}</span>
        {expanded ? (
          <ChevronDown className="w-5 h-5 text-hud-cream-dim" />
        ) : (
          <ChevronRight className="w-5 h-5 text-hud-cream-dim" />
        )}
      </button>
      {expanded && (
        <div className="p-4 bg-hud-bg-mid/50 border-t border-hud-bg-elev">
          {children}
        </div>
      )}
    </div>
  );
}

export function FieldEditorDrawer({
  scope,
  field,
  groups,
  onClose,
  onSaved,
}: FieldEditorDrawerProps) {
  const { user } = useAuth();
  const isEditing = !!field;

  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));

  const [name, setName] = useState(field?.name || '');
  const [fieldKey, setFieldKey] = useState(field?.field_key || '');
  const [description, setDescription] = useState(field?.help_text || '');
  const [fieldType, setFieldType] = useState<CustomFieldType>(field?.field_type || 'text');
  const [groupId, setGroupId] = useState<string | null>(field?.group_id || null);
  const [options, setOptions] = useState<string[]>(field?.options || []);
  const [isRequired, setIsRequired] = useState(field?.is_required || false);
  const [readOnly, setReadOnly] = useState(field?.read_only || false);
  const [placeholder, setPlaceholder] = useState(field?.placeholder || '');
  const [showInListView, setShowInListView] = useState(field?.show_in_list_view || false);
  const [showInDetailView, setShowInDetailView] = useState(field?.show_in_detail_view ?? true);
  const [allowDuplicateValues, setAllowDuplicateValues] = useState(field?.allow_duplicate_values ?? true);
  const [visibleInForms, setVisibleInForms] = useState(field?.visible_in_forms ?? true);
  const [visibleInSurveys, setVisibleInSurveys] = useState(field?.visible_in_surveys ?? true);
  const [visibleInAutomations, setVisibleInAutomations] = useState(field?.visible_in_automations ?? true);
  const [visibleInReporting, setVisibleInReporting] = useState(field?.visible_in_reporting ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [keyEdited, setKeyEdited] = useState(isEditing);
  const [existingValueCount, setExistingValueCount] = useState(0);

  useEffect(() => {
    if (isEditing && field) {
      getFieldValueCount(field.id, scope).then(setExistingValueCount);
    }
  }, [isEditing, field, scope]);

  useEffect(() => {
    if (!keyEdited && name) {
      setFieldKey(generateFieldKey(name));
    }
  }, [name, keyEdited]);

  const needsOptions =
    fieldType === 'select' ||
    fieldType === 'multi_select' ||
    fieldType === 'radio';

  function toggleSection(num: number) {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(num)) {
      newExpanded.delete(num);
    } else {
      newExpanded.add(num);
    }
    setExpandedSections(newExpanded);
  }

  function getDisabledTypes(): CustomFieldType[] {
    if (!isEditing || existingValueCount === 0) return [];
    const allTypes: CustomFieldType[] = [
      'text', 'textarea', 'number', 'currency', 'date', 'datetime',
      'select', 'multi_select', 'checkbox', 'radio', 'boolean',
      'phone', 'email', 'url', 'file'
    ];
    return allTypes.filter(
      (t) => !canMigrateFieldType(field!.field_type, t, SAFE_TYPE_MIGRATIONS)
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;

    setError('');

    if (!name.trim()) {
      setError('Field name is required');
      return;
    }

    if (!fieldKey.trim()) {
      setError('Field key is required');
      return;
    }

    if (needsOptions && options.length === 0) {
      setError('At least one option is required for this field type');
      return;
    }

    setSaving(true);

    try {
      if (isEditing) {
        await updateCustomField(
          field!.id,
          {
            name: name.trim(),
            group_id: groupId,
            field_type: fieldType,
            options: needsOptions ? options : null,
            is_required: isRequired,
            placeholder: placeholder.trim() || null,
            help_text: description.trim() || null,
            visible_in_forms: visibleInForms,
            visible_in_surveys: visibleInSurveys,
            visible_in_automations: visibleInAutomations,
            visible_in_reporting: visibleInReporting,
            read_only: readOnly,
            show_in_list_view: showInListView,
            show_in_detail_view: showInDetailView,
            allow_duplicate_values: allowDuplicateValues,
          },
          user
        );
      } else {
        const input: CreateCustomFieldInput = {
          scope,
          group_id: groupId,
          name: name.trim(),
          field_key: fieldKey.trim(),
          field_type: fieldType,
          options: needsOptions ? options : undefined,
          is_required: isRequired,
          placeholder: placeholder.trim() || undefined,
          help_text: description.trim() || undefined,
          visible_in_forms: visibleInForms,
          visible_in_surveys: visibleInSurveys,
          visible_in_automations: visibleInAutomations,
          visible_in_reporting: visibleInReporting,
          read_only: readOnly,
          show_in_list_view: showInListView,
          show_in_detail_view: showInDetailView,
          allow_duplicate_values: allowDuplicateValues,
        };
        await createCustomField(user.organization_id, input, user);
      }
      onSaved();
    } catch (err) {
      console.error('Failed to save field:', err);
      setError(err instanceof Error ? err.message : 'Failed to save field');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-2xl flex flex-col bg-hud-bg-mid shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev bg-hud-bg-card">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {isEditing ? 'Edit Custom Field' : 'Create Custom Field'}
            </h2>
            <p className="text-sm text-hud-cream-dim mt-0.5">
              {scope === 'contact' ? 'Contact' : 'Opportunity'} Fields
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 p-3 bg-hud-plum/10 border border-hud-plum/30 rounded-lg flex items-start gap-2 text-hud-plum">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {existingValueCount > 0 && (
            <div className="mb-4 p-3 bg-hud-rust/10 border border-hud-rust/30 rounded-lg flex items-start gap-2 text-hud-rust">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <span className="text-sm">
                This field has {existingValueCount} existing value(s). Some changes may be restricted.
              </span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Section
              number={1}
              title="Basic Information"
              expanded={expandedSections.has(1)}
              onToggle={() => toggleSection(1)}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">
                    Field Label <span className="text-hud-plum">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Lead Source"
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">
                    Internal Key <span className="text-hud-plum">*</span>
                  </label>
                  <input
                    type="text"
                    value={fieldKey}
                    onChange={(e) => {
                      setFieldKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    disabled={isEditing}
                    placeholder="lead_source"
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim font-mono text-sm focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed"
                  />
                  {isEditing ? (
                    <p className="mt-1 text-xs text-hud-cream-mute">Internal key cannot be changed after creation</p>
                  ) : (
                    <p className="mt-1 text-xs text-hud-cream-mute">Used for API access and automation tokens</p>
                  )}
                </div>

                <div>
                  <label className="flex items-center gap-1 text-sm font-medium text-hud-cream-soft mb-1">
                    Description
                    <HelpCircle className="w-3.5 h-3.5 text-hud-cream-mute" />
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional helper text shown to users..."
                    rows={2}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-transparent resize-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">Group</label>
                  <select
                    value={groupId || ''}
                    onChange={(e) => setGroupId(e.target.value || null)}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                  >
                    <option value="">No Group (Ungrouped)</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </Section>

            <Section
              number={2}
              title="Field Type"
              expanded={expandedSections.has(2)}
              onToggle={() => toggleSection(2)}
            >
              <FieldTypeSelector
                value={fieldType}
                onChange={setFieldType}
                disabledTypes={getDisabledTypes()}
              />
            </Section>

            {needsOptions && (
              <Section
                number={3}
                title="Field Options"
                expanded={expandedSections.has(3)}
                onToggle={() => toggleSection(3)}
              >
                <OptionListEditor
                  options={options}
                  onChange={setOptions}
                />
              </Section>
            )}

            <Section
              number={needsOptions ? 4 : 3}
              title="Field Rules"
              expanded={expandedSections.has(needsOptions ? 4 : 3)}
              onToggle={() => toggleSection(needsOptions ? 4 : 3)}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">Placeholder</label>
                  <input
                    type="text"
                    value={placeholder}
                    onChange={(e) => setPlaceholder(e.target.value)}
                    placeholder="Enter placeholder text..."
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                  />
                </div>

                <div className="space-y-3 pt-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isRequired}
                      onChange={(e) => setIsRequired(e.target.checked)}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                    />
                    <div>
                      <span className="text-sm text-white">Required field</span>
                      <p className="text-xs text-hud-cream-mute">Users must fill this field</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={readOnly}
                      onChange={(e) => setReadOnly(e.target.checked)}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                    />
                    <div>
                      <span className="text-sm text-white">Read-only</span>
                      <p className="text-xs text-hud-cream-mute">Field value cannot be edited in UI</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showInListView}
                      onChange={(e) => setShowInListView(e.target.checked)}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                    />
                    <div>
                      <span className="text-sm text-white">Show in list views</span>
                      <p className="text-xs text-hud-cream-mute">Display as column in {scope} list</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showInDetailView}
                      onChange={(e) => setShowInDetailView(e.target.checked)}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                    />
                    <div>
                      <span className="text-sm text-white">Show in detail view</span>
                      <p className="text-xs text-hud-cream-mute">Display in {scope} overview/detail panel</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowDuplicateValues}
                      onChange={(e) => setAllowDuplicateValues(e.target.checked)}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                    />
                    <div>
                      <span className="text-sm text-white">Allow duplicate values</span>
                      <p className="text-xs text-hud-cream-mute">Multiple records can have the same value</p>
                    </div>
                  </label>
                </div>
              </div>
            </Section>

            <Section
              number={needsOptions ? 5 : 4}
              title="Visibility & Usage"
              expanded={expandedSections.has(needsOptions ? 5 : 4)}
              onToggle={() => toggleSection(needsOptions ? 5 : 4)}
            >
              <div className="space-y-3">
                <p className="text-sm text-hud-cream-dim mb-4">
                  Control where this field appears throughout the system
                </p>

                {scope === 'contact' && (
                  <>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={visibleInForms}
                        onChange={(e) => setVisibleInForms(e.target.checked)}
                        className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                      />
                      <div>
                        <span className="text-sm text-white">Available in Forms</span>
                        <p className="text-xs text-hud-cream-mute">Show in Form Builder field picker</p>
                      </div>
                    </label>

                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={visibleInSurveys}
                        onChange={(e) => setVisibleInSurveys(e.target.checked)}
                        className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                      />
                      <div>
                        <span className="text-sm text-white">Available in Surveys</span>
                        <p className="text-xs text-hud-cream-mute">Show in Survey Builder field picker</p>
                      </div>
                    </label>
                  </>
                )}

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibleInAutomations}
                    onChange={(e) => setVisibleInAutomations(e.target.checked)}
                    className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                  />
                  <div>
                    <span className="text-sm text-white">Available in Automations</span>
                    <p className="text-xs text-hud-cream-mute">Use as condition or action in workflows</p>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibleInReporting}
                    onChange={(e) => setVisibleInReporting(e.target.checked)}
                    className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                  />
                  <div>
                    <span className="text-sm text-white">Available in Reporting</span>
                    <p className="text-xs text-hud-cream-mute">Use as dimension or filter in reports</p>
                  </div>
                </label>
              </div>
            </Section>
          </form>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-hud-bg-elev bg-hud-bg-card">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-hud-cream-soft border border-hud-cream-mute rounded-lg hover:bg-hud-bg-elev transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-hud-gold to-hud-teal rounded-lg hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Field'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
