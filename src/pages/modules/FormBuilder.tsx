import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Eye,
  Settings,
  Plus,
  Trash2,
  GripVertical,
  Globe,
  Type,
  Mail,
  Phone,
  Building2,
  Link as LinkIcon,
  MapPin,
  AlignLeft,
  Hash,
  ChevronDown,
  ChevronsUpDown,
  CheckSquare,
  Calendar,
  EyeOff,
  ShieldCheck,
  Circle,
  Upload,
  Minus,
  Code,
  FileCode,
  GitBranch,
  X,
  DollarSign,
  Map,
  Mailbox,
  Clock,
  CreditCard,
  ShoppingCart,
  Smartphone,
  BadgeCheck,
  Calculator,
  Columns,
  Tag,
  ListChecks,
  List,
  PenTool,
} from 'lucide-react';
import { getFormById, updateForm, publishForm, unpublishForm } from '../../services/forms';
import type { Form, FormField, FormFieldType, FormDefinition, FormSettings, FormConditionalRule } from '../../types';
import {
  US_STATES,
  COUNTRIES,
  COMMON_TIMEZONES,
  currencySymbol,
} from '../../constants/formFieldOptions';
import { EditableText } from '../../components/EditableText';
import { ThemePicker } from '../../components/ThemePicker';
import { SubmitRulesEditor } from '../../components/SubmitRulesEditor';
import { MappingPicker } from '../../components/MappingPicker';
import { Monitor, LayoutTemplate, Sparkles } from 'lucide-react';
import { FORM_TEMPLATES, type FormTemplate } from '../../constants/formTemplates';
import { FieldValidationRulesEditor } from '../../components/fields/FieldValidationRulesEditor';
import { FieldDefaultValueInput } from '../../components/fields/FieldDefaultValueInput';
import { EmbedCodeModal } from '../../components/fields/EmbedCodeModal';
import { FieldCardShell, ColumnLayoutHint, FieldOptionsPreview } from '../../components/fields/FieldCardParts';
import {
  CurrencySetting, HtmlContentSetting, ColumnCountSetting, HeadingLevelSetting,
  CharacterLimitSetting, PhoneFormatSetting, EmailDeliverabilitySetting, AddressSettings,
  AllowOtherSetting, SelectionLimitsSetting, ConsentDescriptionSetting, FormulaSetting,
} from '../../components/fields/FieldSettingControls';
import { Portal } from '../../components/shared/Portal';

interface FieldTypeConfig {
  type: FormFieldType;
  label: string;
  icon: React.ElementType;
  category: 'contact' | 'address' | 'input' | 'choice' | 'advanced' | 'layout' | 'special';
}

const FIELD_TYPES: FieldTypeConfig[] = [
  { type: 'first_name', label: 'First Name', icon: Type, category: 'contact' },
  { type: 'last_name', label: 'Last Name', icon: Type, category: 'contact' },
  { type: 'full_name', label: 'Full Name', icon: Type, category: 'contact' },
  { type: 'email', label: 'Email', icon: Mail, category: 'contact' },
  { type: 'phone', label: 'Phone', icon: Phone, category: 'contact' },
  { type: 'company', label: 'Company Name', icon: Building2, category: 'contact' },
  { type: 'website', label: 'URL / Website', icon: LinkIcon, category: 'contact' },

  { type: 'address', label: 'Address', icon: MapPin, category: 'address' },
  { type: 'city', label: 'City', icon: Building2, category: 'address' },
  { type: 'state', label: 'State', icon: Map, category: 'address' },
  { type: 'postal_code', label: 'Postal / Zip Code', icon: Mailbox, category: 'address' },
  { type: 'country', label: 'Country', icon: Globe, category: 'address' },
  { type: 'timezone', label: 'Timezone', icon: Clock, category: 'address' },

  { type: 'text', label: 'Single Line / Short Text', icon: Type, category: 'input' },
  { type: 'textarea', label: 'Multi Line / Long Text', icon: AlignLeft, category: 'input' },
  { type: 'textbox_list', label: 'Textbox List', icon: List, category: 'input' },
  { type: 'number', label: 'Number', icon: Hash, category: 'input' },
  { type: 'monetary', label: 'Monetary', icon: DollarSign, category: 'input' },
  { type: 'date', label: 'Date Picker', icon: Calendar, category: 'input' },

  { type: 'radio', label: 'Radio Select', icon: Circle, category: 'choice' },
  { type: 'dropdown', label: 'Single Dropdown', icon: ChevronDown, category: 'choice' },
  { type: 'multi_dropdown', label: 'Multi Dropdown', icon: ChevronsUpDown, category: 'choice' },
  { type: 'multi_select', label: 'Multi-Select Checkboxes', icon: CheckSquare, category: 'choice' },
  { type: 'checkbox', label: 'Checkbox', icon: CheckSquare, category: 'choice' },
  { type: 'checkbox_group', label: 'Checkbox Group', icon: ListChecks, category: 'choice' },

  { type: 'source', label: 'Source', icon: Tag, category: 'advanced' },
  { type: 'payment', label: 'Payment Element', icon: CreditCard, category: 'advanced' },
  { type: 'product_selection', label: 'Product Selection', icon: ShoppingCart, category: 'advanced' },
  { type: 'sms_verification', label: 'SMS Verification', icon: Smartphone, category: 'advanced' },
  { type: 'email_validation', label: 'Email Validation', icon: BadgeCheck, category: 'advanced' },
  { type: 'math_calculation', label: 'Math Calculation', icon: Calculator, category: 'advanced' },

  { type: 'heading', label: 'Heading', icon: Type, category: 'layout' },
  { type: 'paragraph', label: 'Paragraph', icon: AlignLeft, category: 'layout' },
  { type: 'section', label: 'Section Title', icon: Minus, category: 'layout' },
  { type: 'divider', label: 'Divider', icon: Minus, category: 'layout' },
  { type: 'column', label: 'Column / Layout', icon: Columns, category: 'layout' },
  { type: 'custom_html', label: 'Custom HTML', icon: FileCode, category: 'layout' },

  { type: 'file_upload', label: 'File Upload', icon: Upload, category: 'special' },
  { type: 'signature', label: 'Signature', icon: PenTool, category: 'special' },
  { type: 'hidden', label: 'Hidden Field', icon: EyeOff, category: 'special' },
  { type: 'consent', label: 'Consent Checkbox', icon: ShieldCheck, category: 'special' },
];

const FIELD_CATEGORIES = [
  { id: 'contact', label: 'Contact Fields' },
  { id: 'address', label: 'Address Fields' },
  { id: 'input', label: 'Input Fields' },
  { id: 'choice', label: 'Choice Fields' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'layout', label: 'Layout' },
  { id: 'special', label: 'Special' },
];

function generateFieldId(): string {
  return `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getDefaultLabel(type: FormFieldType): string {
  const fieldType = FIELD_TYPES.find((f) => f.type === type);
  return fieldType?.label || 'Field';
}

export function FormBuilder() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'fields' | 'settings'>('fields');
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    contact: true,
    address: false,
    input: true,
    choice: true,
    advanced: false,
    layout: false,
    special: false,
  });

  useEffect(() => {
    if (id) loadForm();
  }, [id]);

  async function loadForm() {
    try {
      setLoading(true);
      const data = await getFormById(id!);
      if (data) {
        setForm(data);
      } else {
        navigate('/marketing/forms');
      }
    } catch (error) {
      console.error('Failed to load form:', error);
      navigate('/marketing/forms');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!form) return;

    try {
      setSaving(true);
      await updateForm(form.id, {
        name: form.name,
        description: form.description,
        definition: form.definition,
        settings: form.settings,
      });
    } catch (error) {
      console.error('Failed to save form:', error);
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!form) return;

    try {
      await handleSave();
      const updated = await publishForm(form.id);
      setForm(updated);
    } catch (error) {
      console.error('Failed to publish form:', error);
    }
  }

  async function handleUnpublish() {
    if (!form) return;

    try {
      const updated = await unpublishForm(form.id);
      setForm(updated);
    } catch (error) {
      console.error('Failed to unpublish form:', error);
    }
  }

  function addField(type: FormFieldType) {
    if (!form) return;

    const newField: FormField = {
      id: generateFieldId(),
      type,
      label: type === 'divider' || type === 'column' || type === 'custom_html' ? '' : getDefaultLabel(type),
      required: false,
      width: 'full',
    };

    if (
      type === 'dropdown' ||
      type === 'multi_select' ||
      type === 'multi_dropdown' ||
      type === 'radio' ||
      type === 'checkbox_group' ||
      type === 'product_selection'
    ) {
      newField.options = [
        { label: 'Option 1', value: 'option_1' },
        { label: 'Option 2', value: 'option_2' },
      ];
    }

    if (type === 'file_upload') {
      newField.fileUploadConfig = {
        maxSizeBytes: 10485760,
        allowedTypes: ['image/*', 'application/pdf', '.doc', '.docx'],
        maxFiles: 1,
      };
    }

    if (type === 'monetary') {
      newField.currency = 'USD';
    }

    if (type === 'custom_html') {
      newField.htmlContent = '<p>Custom HTML content</p>';
    }

    if (type === 'math_calculation') {
      newField.formula = '';
    }

    if (type === 'column') {
      newField.columnCount = 2;
    }

    if (type === 'textbox_list') {
      newField.options = [
        { label: 'Item', value: '' },
      ];
    }

    setForm({
      ...form,
      definition: {
        ...form.definition,
        fields: [...form.definition.fields, newField],
      },
    });
    setSelectedFieldId(newField.id);
  }

  function updateField(fieldId: string, updates: Partial<FormField>) {
    if (!form) return;

    setForm({
      ...form,
      definition: {
        ...form.definition,
        fields: form.definition.fields.map((f) =>
          f.id === fieldId ? { ...f, ...updates } : f
        ),
      },
    });
  }

  function removeField(fieldId: string) {
    if (!form) return;

    setForm({
      ...form,
      definition: {
        ...form.definition,
        fields: form.definition.fields.filter((f) => f.id !== fieldId),
      },
    });
    if (selectedFieldId === fieldId) {
      setSelectedFieldId(null);
    }
  }

  function moveField(fromIndex: number, toIndex: number) {
    if (!form) return;

    const fields = [...form.definition.fields];
    const [moved] = fields.splice(fromIndex, 1);
    fields.splice(toIndex, 0, moved);

    setForm({
      ...form,
      definition: { ...form.definition, fields },
    });
  }

  function updateSettings(updates: Partial<FormSettings>) {
    if (!form) return;

    setForm({
      ...form,
      settings: { ...form.settings, ...updates },
    });
  }

  const selectedField = form?.definition.fields.find(
    (f) => f.id === selectedFieldId
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!form) return null;

  return (
    <div className="h-[calc(100dvh-4rem-var(--safe-top)-var(--bottom-nav))] flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev bg-hud-bg-card">
        <div className="flex items-center gap-4">
          <Link
            to="/marketing/forms"
            className="p-2 hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
          </Link>
          <div>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="text-xl font-semibold text-white bg-transparent hover:bg-hud-bg-elev focus:bg-hud-bg-elev placeholder:text-hud-cream-dim border-none focus:outline-none focus:ring-2 focus:ring-hud-gold rounded px-2 -ml-2"
            />
            <div className="text-sm text-hud-cream-dim ml-2">
              {form.status === 'published' ? (
                <span className="text-green-600">Published</span>
              ) : (
                <span>Draft</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {previewMode && (
            <div className="flex items-center bg-hud-bg-elev rounded-lg p-0.5">
              <button
                onClick={() => setPreviewDevice('desktop')}
                title="Desktop preview"
                className={`p-1.5 rounded ${
                  previewDevice === 'desktop'
                    ? 'bg-hud-bg-card shadow text-white'
                    : 'text-hud-cream-dim hover:text-hud-cream-soft'
                }`}
              >
                <Monitor className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPreviewDevice('mobile')}
                title="Mobile preview"
                className={`p-1.5 rounded ${
                  previewDevice === 'mobile'
                    ? 'bg-hud-bg-card shadow text-white'
                    : 'text-hud-cream-dim hover:text-hud-cream-soft'
                }`}
              >
                <Smartphone className="w-4 h-4" />
              </button>
            </div>
          )}
          <button
            onClick={() => setPreviewMode(!previewMode)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
              previewMode
                ? 'bg-blue-100 text-blue-700'
                : 'text-hud-cream-dim hover:bg-hud-bg-elev'
            }`}
          >
            <Eye className="w-4 h-4" />
            Preview
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-hud-cream-dim hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save'}
          </button>
          {form.status === 'published' ? (
            <>
              <button
                onClick={() => setShowEmbedModal(true)}
                className="flex items-center gap-2 px-4 py-2 text-hud-cream-dim hover:bg-hud-bg-elev rounded-lg transition-colors"
              >
                <Code className="w-4 h-4" />
                Embed
              </button>
              <button
                onClick={handleUnpublish}
                className="flex items-center gap-2 px-4 py-2 bg-yellow-100 text-yellow-700 rounded-lg hover:bg-yellow-200 transition-colors"
              >
                Unpublish
              </button>
            </>
          ) : (
            <button
              onClick={handlePublish}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Globe className="w-4 h-4" />
              Publish
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-64 border-r border-hud-bg-elev bg-hud-bg-card overflow-y-auto">
          <div className="p-4">
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setActiveTab('fields')}
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === 'fields'
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-hud-cream-dim hover:bg-hud-bg-elev'
                }`}
              >
                Fields
              </button>
              <button
                onClick={() => setActiveTab('settings')}
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === 'settings'
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-hud-cream-dim hover:bg-hud-bg-elev'
                }`}
              >
                <Settings className="w-4 h-4 inline mr-1" />
                Settings
              </button>
            </div>

            {activeTab === 'fields' ? (
              <div className="space-y-3">
                {FIELD_CATEGORIES.map((category) => {
                  const categoryFields = FIELD_TYPES.filter(
                    (f) => f.category === category.id
                  );
                  const isExpanded = expandedCategories[category.id];
                  return (
                    <div key={category.id}>
                      <button
                        onClick={() =>
                          setExpandedCategories((prev) => ({
                            ...prev,
                            [category.id]: !prev[category.id],
                          }))
                        }
                        className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-medium text-hud-cream-dim uppercase tracking-wider hover:bg-hud-bg-elev/50 rounded"
                      >
                        {category.label}
                        <ChevronDown
                          className={`w-4 h-4 transition-transform ${
                            isExpanded ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                      {isExpanded && (
                        <div className="mt-1 space-y-1">
                          {categoryFields.map((field) => (
                            <button
                              key={field.type}
                              onClick={() => addField(field.type)}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded-lg transition-colors"
                            >
                              <field.icon className="w-4 h-4 text-hud-cream-mute" />
                              {field.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <FormSettingsPanel
                settings={form.settings}
                onUpdate={updateSettings}
                availableFields={form.definition.fields
                  .filter((f) => f.type !== 'divider' && f.type !== 'column' && f.type !== 'custom_html' && f.type !== 'hidden')
                  .map((f) => ({ id: f.id, label: f.label || `(unnamed ${f.type})` }))}
              />
            )}
          </div>
        </div>

        <div className="flex-1 bg-hud-bg-card/50 overflow-y-auto p-6">
          {previewMode ? (
            <div
              className={
                previewDevice === 'mobile'
                  ? 'mx-auto max-w-[375px] border border-hud-bg-elev rounded-2xl shadow-lg overflow-hidden'
                  : ''
              }
            >
              <FormPreview form={form} />
            </div>
          ) : (
            <div className="max-w-2xl mx-auto">
              <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
                {form.definition.fields.length === 0 ? (
                  <div className="text-center py-12 text-hud-cream-dim">
                    <Plus className="w-12 h-12 mx-auto mb-4 text-hud-cream-soft" />
                    <p className="mb-4">Add fields from the left panel</p>
                    <button
                      onClick={() => setShowTemplateModal(true)}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                    >
                      <LayoutTemplate className="w-4 h-4" />
                      Start from a template
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {form.definition.fields.map((field, index) => (
                      <FieldCard
                        key={field.id}
                        field={field}
                        index={index}
                        isSelected={selectedFieldId === field.id}
                        onSelect={() => setSelectedFieldId(field.id)}
                        onRemove={() => removeField(field.id)}
                        onMoveUp={() =>
                          index > 0 && moveField(index, index - 1)
                        }
                        onMoveDown={() =>
                          index < form.definition.fields.length - 1 &&
                          moveField(index, index + 1)
                        }
                        onUpdate={(updates) => updateField(field.id, updates)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {selectedField && !previewMode && (
          <div className="w-80 border-l border-hud-bg-elev bg-hud-bg-card overflow-y-auto">
            <FieldEditor
              field={selectedField}
              allFields={form.definition.fields}
              onUpdate={(updates) => updateField(selectedField.id, updates)}
              onClose={() => setSelectedFieldId(null)}
            />
          </div>
        )}
      </div>

      {showEmbedModal && form.public_slug && (
        <EmbedCodeModal
          slug={form.public_slug}
          kind="form"
          onClose={() => setShowEmbedModal(false)}
        />
      )}

      {showTemplateModal && (
        <FormTemplateModal
          onClose={() => setShowTemplateModal(false)}
          onApply={(template) => {
            const fields: FormField[] = template.fields.map((tf) => ({
              id: generateFieldId(),
              type: tf.type,
              label: tf.label,
              required: tf.required ?? false,
              placeholder: tf.placeholder,
              helpText: tf.helpText,
              options: tf.options,
              width: 'full',
            }));
            setForm({
              ...form,
              definition: { ...form.definition, fields },
            });
            setShowTemplateModal(false);
          }}
        />
      )}
    </div>
  );
}

function FormTemplateModal({
  onClose,
  onApply,
}: {
  onClose: () => void;
  onApply: (template: FormTemplate) => void;
}) {
  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-card rounded-xl shadow-xl w-full max-w-3xl max-h-[80dvh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-white">Start from a template</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-hud-bg-elev rounded-lg">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>
        <div className="p-6 grid sm:grid-cols-2 gap-4 overflow-y-auto">
          {FORM_TEMPLATES.map((template) => (
            <button
              key={template.id}
              onClick={() => onApply(template)}
              className="text-left p-4 border-2 border-hud-bg-elev rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
            >
              <div className="flex items-center gap-2 mb-2">
                <LayoutTemplate className="w-4 h-4 text-blue-600" />
                <span className="font-semibold text-white">{template.name}</span>
              </div>
              <p className="text-sm text-hud-cream-dim mb-3">{template.description}</p>
              <div className="text-xs text-hud-cream-dim">
                {template.fields.length} field{template.fields.length === 1 ? '' : 's'}
              </div>
            </button>
          ))}
        </div>
        <div className="p-4 border-t border-hud-bg-elev bg-hud-bg-card/50">
          <p className="text-xs text-hud-cream-dim">
            Applying a template replaces all current fields. You can still edit, add, and remove fields after.
          </p>
        </div>
      </div>
    </div></Portal>
  );
}

function FieldCard({
  field,
  isSelected,
  onSelect,
  onRemove,
  onMoveUp,
  onUpdate,
}: {
  field: FormField;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onUpdate: (updates: Partial<FormField>) => void;
}) {
  const fieldType = FIELD_TYPES.find((f) => f.type === field.type);
  const Icon = fieldType?.icon || Type;
  const isLayoutOnly = field.type === 'divider' || field.type === 'column' || field.type === 'custom_html';
  const showPlaceholder =
    !isLayoutOnly &&
    field.type !== 'checkbox' &&
    field.type !== 'consent' &&
    field.type !== 'file_upload' &&
    field.type !== 'hidden';

  return (
    <FieldCardShell
      isSelected={isSelected}
      onSelect={onSelect}
      onRemove={onRemove}
      grip={
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMoveUp();
          }}
          className="p-1 hover:bg-hud-cream-mute rounded"
        >
          <GripVertical className="w-4 h-4 text-hud-cream-mute" />
        </button>
      }
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-hud-cream-mute shrink-0" />
        {isLayoutOnly ? (
          <span className="font-medium text-hud-cream-dim italic">{fieldType?.label}</span>
        ) : (
          <EditableText
            value={field.label}
            onChange={(next) => onUpdate({ label: next })}
            placeholder="Untitled field"
            className="font-medium text-white"
          />
        )}
        {field.required && <span className="text-hud-plum text-sm">*</span>}
      </div>
      <div className="text-sm text-hud-cream-dim">{fieldType?.label}</div>
      {field.type === 'column' && (
        <ColumnLayoutHint count={field.columnCount || 2} noun="field" />
      )}
      {showPlaceholder && (
        <EditableText
          value={field.placeholder || ''}
          onChange={(next) => onUpdate({ placeholder: next })}
          placeholder="Click to add placeholder…"
          className="text-xs text-hud-cream-mute italic mt-1"
        />
      )}
      {!isLayoutOnly && (
        <FieldOptionsPreview
          options={field.options || []}
          onChange={(next) => onUpdate({ options: next })}
          keyFor={(_, i) => i}
        />
      )}
    </FieldCardShell>
  );
}

function FieldEditor({
  field,
  allFields,
  onUpdate,
  onClose,
}: {
  field: FormField;
  allFields: FormField[];
  onUpdate: (updates: Partial<FormField>) => void;
  onClose: () => void;
}) {
  const [activeSection, setActiveSection] = useState<'general' | 'conditional' | 'validation'>('general');
  const isDivider = field.type === 'divider';

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white">Field Settings</h3>
        <button onClick={onClose} className="p-1 hover:bg-hud-bg-elev rounded">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex gap-1 mb-4 p-1 bg-hud-bg-elev rounded-lg">
        <button
          onClick={() => setActiveSection('general')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeSection === 'general' ? 'bg-hud-bg-card text-white shadow-sm' : 'text-hud-cream-dim hover:text-white'
          }`}
        >
          General
        </button>
        {!isDivider && (
          <>
            <button
              onClick={() => setActiveSection('conditional')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeSection === 'conditional' ? 'bg-hud-bg-card text-white shadow-sm' : 'text-hud-cream-dim hover:text-white'
              }`}
            >
              <GitBranch className="w-3 h-3 inline mr-1" />
              Logic
            </button>
            <button
              onClick={() => setActiveSection('validation')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeSection === 'validation' ? 'bg-hud-bg-card text-white shadow-sm' : 'text-hud-cream-dim hover:text-white'
              }`}
            >
              Validation
            </button>
          </>
        )}
      </div>

      {activeSection === 'general' && (
        <div className="space-y-4">
          {!isDivider && (
            <>
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Label</label>
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => onUpdate({ label: e.target.value })}
                  className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Help Text</label>
                <input
                  type="text"
                  value={field.helpText || ''}
                  onChange={(e) => onUpdate({ helpText: e.target.value })}
                  placeholder="Optional description"
                  className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {field.type !== 'checkbox' && field.type !== 'consent' && field.type !== 'file_upload' && (
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">Placeholder</label>
                  <input
                    type="text"
                    value={field.placeholder || ''}
                    onChange={(e) => onUpdate({ placeholder: e.target.value })}
                    className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="required"
                  checked={field.required}
                  onChange={(e) => onUpdate({ required: e.target.checked })}
                  className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="required" className="text-sm text-hud-cream-soft">Required field</label>
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Width</label>
            <select
              value={field.customWidthPercent ? 'custom' : (field.width || 'full')}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  onUpdate({ customWidthPercent: 50, width: undefined });
                } else {
                  onUpdate({ width: e.target.value as FormField['width'], customWidthPercent: undefined });
                }
              }}
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="full">Full Width</option>
              <option value="two_thirds">2/3 Width</option>
              <option value="half">Half Width</option>
              <option value="third">1/3 Width</option>
              <option value="custom">Custom %</option>
            </select>
            {field.customWidthPercent !== undefined && (
              <input
                type="number"
                min={5}
                max={100}
                value={field.customWidthPercent}
                onChange={(e) => onUpdate({ customWidthPercent: Math.max(5, Math.min(100, parseInt(e.target.value) || 50)) })}
                className="mt-2 w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            )}
          </div>

          {!isDivider && field.type !== 'column' && field.type !== 'custom_html' && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Custom CSS Class</label>
              <input
                type="text"
                value={field.customClassName || ''}
                onChange={(e) => onUpdate({ customClassName: e.target.value })}
                placeholder="e.g. my-special-field"
                className="w-full px-3 py-2 font-mono text-xs border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {!isDivider && field.type !== 'column' && field.type !== 'custom_html' && field.type !== 'hidden' && field.type !== 'file_upload' && (
            <FieldDefaultValueInput field={field} onUpdate={onUpdate} options={field.options} noun="field" />
          )}

          {!isDivider && field.type !== 'column' && field.type !== 'custom_html' && field.type !== 'hidden' && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Label Alignment</label>
              <select
                value={field.labelAlignment || 'top'}
                onChange={(e) => onUpdate({ labelAlignment: e.target.value as FormField['labelAlignment'] })}
                className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="top">Top (default)</option>
                <option value="left">Left of input</option>
                <option value="inline">Inline (hide label, use placeholder)</option>
              </select>
            </div>
          )}

          {(field.type === 'dropdown' || field.type === 'radio' || field.type === 'multi_select' || field.type === 'multi_dropdown' || field.type === 'checkbox_group') && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Options Layout</label>
              <select
                value={field.optionsLayout || 'vertical'}
                onChange={(e) => onUpdate({ optionsLayout: e.target.value as FormField['optionsLayout'] })}
                className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="vertical">Vertical (default)</option>
                <option value="horizontal">Horizontal (inline)</option>
                <option value="columns_2">2 columns</option>
                <option value="columns_3">3 columns</option>
              </select>
            </div>
          )}

          {!isDivider && field.type !== 'column' && field.type !== 'custom_html' && field.type !== 'hidden' && (
            <MappingPicker
              value={field.mapping}
              onChange={(mapping) => onUpdate({ mapping })}
              fieldType={field.type}
              fieldLabel={field.label}
              scope="contact"
              visibleInProperty="visible_in_forms"
            />
          )}

          {(field.type === 'dropdown' || field.type === 'multi_select' || field.type === 'radio') && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Options</label>
              <div className="space-y-2">
                {(field.options || []).map((option, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input
                      type="text"
                      value={option.label}
                      onChange={(e) => {
                        const newOptions = [...(field.options || [])];
                        newOptions[idx] = {
                          ...option,
                          label: e.target.value,
                          value: e.target.value.toLowerCase().replace(/\s+/g, '_'),
                        };
                        onUpdate({ options: newOptions });
                      }}
                      className="flex-1 px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => {
                        const newOptions = (field.options || []).filter((_, i) => i !== idx);
                        onUpdate({ options: newOptions });
                      }}
                      className="p-2 text-hud-plum hover:bg-hud-plum/10 rounded-lg"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const newOptions = [
                      ...(field.options || []),
                      { label: `Option ${(field.options || []).length + 1}`, value: `option_${(field.options || []).length + 1}` },
                    ];
                    onUpdate({ options: newOptions });
                  }}
                  className="w-full px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                >
                  + Add Option
                </button>
              </div>
            </div>
          )}

          {field.type === 'file_upload' && (
            <FileUploadSettings field={field} onUpdate={onUpdate} />
          )}

          {field.type === 'math_calculation' && (
            <FormulaSetting field={field} onUpdate={onUpdate} siblings={allFields} noun="field" />
          )}

          {field.type === 'monetary' && <CurrencySetting field={field} onUpdate={onUpdate} />}

          {field.type === 'custom_html' && <HtmlContentSetting field={field} onUpdate={onUpdate} />}

          {field.type === 'column' && <ColumnCountSetting field={field} onUpdate={onUpdate} />}

          {field.type === 'heading' && <HeadingLevelSetting field={field} onUpdate={onUpdate} />}

          {field.type === 'paragraph' && (
            <p className="text-xs text-hud-cream-dim -mt-2">
              The Label above is the paragraph body. Use line breaks for new lines. Inline-edit on the canvas.
            </p>
          )}

          {field.type === 'section' && (
            <p className="text-xs text-hud-cream-dim -mt-2">
              Section Title renders above an horizontal divider. Inline-edit the title via the Label above.
            </p>
          )}

          {(field.type === 'text' || field.type === 'textarea') && (
            <CharacterLimitSetting field={field} onUpdate={onUpdate} />
          )}

          {field.type === 'phone' && <PhoneFormatSetting field={field} onUpdate={onUpdate} />}

          {field.type === 'email' && <EmailDeliverabilitySetting field={field} onUpdate={onUpdate} />}

          {field.type === 'address' && <AddressSettings field={field} onUpdate={onUpdate} />}

          {(field.type === 'dropdown' || field.type === 'radio' || field.type === 'multi_select' || field.type === 'multi_dropdown' || field.type === 'checkbox_group') && (
            <AllowOtherSetting field={field} onUpdate={onUpdate} />
          )}

          {(field.type === 'multi_select' || field.type === 'multi_dropdown' || field.type === 'checkbox_group') && (
            <SelectionLimitsSetting field={field} onUpdate={onUpdate} />
          )}

          {field.type === 'consent' && <ConsentDescriptionSetting field={field} onUpdate={onUpdate} />}

          {field.type === 'hidden' && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">URL parameter key</label>
              <input
                type="text"
                value={field.hiddenParamKey || ''}
                onChange={(e) => onUpdate({ hiddenParamKey: e.target.value })}
                placeholder="utm_campaign"
                className="w-full px-3 py-2 font-mono text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-hud-cream-dim mt-1">
                Pre-filled from <code>?{field.hiddenParamKey || 'key'}=</code> on the form URL.
              </p>
            </div>
          )}

          {field.type === 'source' && (
            <p className="text-xs text-hud-cream-dim -mt-2">
              The Default Value above is used unless the form URL includes <code>?source=</code>, which overrides it.
            </p>
          )}

          {field.type === 'signature' && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Signature pad height (px)</label>
              <input
                type="number"
                min={80}
                max={400}
                value={field.signaturePadHeight ?? 120}
                onChange={(e) => onUpdate({ signaturePadHeight: parseInt(e.target.value) || 120 })}
                className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
        </div>
      )}

      {activeSection === 'conditional' && (
        <ConditionalLogicEditor field={field} allFields={allFields} onUpdate={onUpdate} />
      )}

      {activeSection === 'validation' && (
        <FieldValidationRulesEditor field={field} onUpdate={onUpdate} noun="field" />
      )}
    </div>
  );
}

const FILE_TYPE_OPTIONS: { type: string; label: string }[] = [
  { type: 'application/pdf', label: 'PDF' },
  { type: '.doc,.docx', label: 'Word (.doc, .docx)' },
  { type: '.xls,.xlsx', label: 'Excel (.xls, .xlsx)' },
  { type: 'image/jpeg', label: 'JPG / JPEG' },
  { type: 'image/png', label: 'PNG' },
  { type: 'image/gif', label: 'GIF' },
  { type: 'image/svg+xml', label: 'SVG' },
  { type: 'video/mp4', label: 'MP4' },
  { type: 'video/mpeg', label: 'MPEG' },
  { type: 'audio/mpeg', label: 'MP3' },
  { type: '.zip', label: 'ZIP' },
  { type: '.rar', label: 'RAR' },
  { type: 'text/csv', label: 'CSV' },
  { type: 'text/plain', label: 'TXT' },
];

function FileUploadSettings({
  field,
  onUpdate,
}: {
  field: FormField;
  onUpdate: (updates: Partial<FormField>) => void;
}) {
  const config = field.fileUploadConfig || {
    maxSizeBytes: 50 * 1048576,
    allowedTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxFiles: 1,
  };

  const sizeInMB = Math.round(config.maxSizeBytes / 1048576);

  return (
    <div className="space-y-4 pt-2 border-t border-hud-bg-elev">
      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-1">Max File Size (MB)</label>
        <select
          value={sizeInMB}
          onChange={(e) =>
            onUpdate({
              fileUploadConfig: { ...config, maxSizeBytes: parseInt(e.target.value) * 1048576 },
            })
          }
          className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value={5}>5 MB</option>
          <option value={10}>10 MB</option>
          <option value={25}>25 MB</option>
          <option value={50}>50 MB (default)</option>
          <option value={100}>100 MB</option>
        </select>
      </div>

      <label className="flex items-start gap-2 text-sm text-hud-cream-soft">
        <input
          type="checkbox"
          checked={field.allowMultiple || (config.maxFiles > 1)}
          onChange={(e) => {
            const allowMultiple = e.target.checked;
            onUpdate({
              allowMultiple,
              fileUploadConfig: { ...config, maxFiles: allowMultiple ? Math.max(2, config.maxFiles) : 1 },
            });
          }}
          className="mt-0.5 rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
        />
        <span>Allow multiple file uploads</span>
      </label>

      {(field.allowMultiple || config.maxFiles > 1) && (
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1">Max Files</label>
          <input
            type="number"
            min={1}
            max={10}
            value={config.maxFiles}
            onChange={(e) =>
              onUpdate({
                fileUploadConfig: { ...config, maxFiles: parseInt(e.target.value) || 1 },
              })
            }
            className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-1">Allowed File Types</label>
        <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
          {FILE_TYPE_OPTIONS.map((opt) => (
            <label key={opt.type} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={config.allowedTypes.includes(opt.type)}
                onChange={(e) => {
                  const newTypes = e.target.checked
                    ? [...config.allowedTypes, opt.type]
                    : config.allowedTypes.filter((t) => t !== opt.type);
                  onUpdate({ fileUploadConfig: { ...config, allowedTypes: newTypes } });
                }}
                className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConditionalLogicEditor({
  field,
  allFields,
  onUpdate,
}: {
  field: FormField;
  allFields: FormField[];
  onUpdate: (updates: Partial<FormField>) => void;
}) {
  const rules = field.conditionalRules || [];
  const otherFields = allFields.filter(
    (f) => f.id !== field.id && f.type !== 'divider' && f.type !== 'hidden'
  );

  function addRule() {
    const newRule: FormConditionalRule = {
      fieldId: otherFields[0]?.id || '',
      operator: 'equals',
      value: '',
    };
    onUpdate({ conditionalRules: [...rules, newRule] });
  }

  function updateRule(index: number, updates: Partial<FormConditionalRule>) {
    const newRules = [...rules];
    newRules[index] = { ...newRules[index], ...updates };
    onUpdate({ conditionalRules: newRules });
  }

  function removeRule(index: number) {
    onUpdate({ conditionalRules: rules.filter((_, i) => i !== index) });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-hud-cream-dim">
        Show this field only when the following conditions are met:
      </p>

      {rules.length === 0 ? (
        <div className="text-center py-6 bg-hud-bg-card/50 rounded-lg">
          <GitBranch className="w-8 h-8 mx-auto text-hud-cream-soft mb-2" />
          <p className="text-sm text-hud-cream-dim">No conditions set</p>
          <p className="text-xs text-hud-cream-mute">Field is always visible</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule, idx) => {
            const sourceField = otherFields.find((f) => f.id === rule.fieldId);
            return (
              <div key={idx} className="p-3 bg-hud-bg-card/50 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-hud-cream-dim">
                    {idx === 0 ? 'IF' : 'AND'}
                  </span>
                  <button
                    onClick={() => removeRule(idx)}
                    className="p-1 text-hud-cream-mute hover:text-hud-plum"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <select
                  value={rule.fieldId}
                  onChange={(e) => updateRule(idx, { fieldId: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {otherFields.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>

                <select
                  value={rule.operator}
                  onChange={(e) => updateRule(idx, { operator: e.target.value as FormConditionalRule['operator'] })}
                  className="w-full px-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="equals">Equals</option>
                  <option value="not_equals">Does not equal</option>
                  <option value="contains">Contains</option>
                  {(sourceField?.type === 'number' || sourceField?.type === 'monetary' || sourceField?.type === 'math_calculation') && (
                    <>
                      <option value="greater_than">Greater than</option>
                      <option value="less_than">Less than</option>
                      <option value="between">Between</option>
                    </>
                  )}
                  {sourceField?.type === 'date' && (
                    <>
                      <option value="before">Before</option>
                      <option value="after">After</option>
                      <option value="between">Between</option>
                    </>
                  )}
                  <option value="is_empty">Is empty</option>
                  <option value="is_not_empty">Is not empty</option>
                </select>

                {rule.operator !== 'is_empty' && rule.operator !== 'is_not_empty' && (
                  <>
                    {sourceField?.options ? (
                      <select
                        value={rule.value}
                        onChange={(e) => updateRule(idx, { value: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Select value...</option>
                        {sourceField.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={sourceField?.type === 'date' ? 'date' : (sourceField?.type === 'number' || sourceField?.type === 'monetary') ? 'number' : 'text'}
                        value={rule.value}
                        onChange={(e) => updateRule(idx, { value: e.target.value })}
                        placeholder="Value"
                        className="w-full px-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    )}
                    {rule.operator === 'between' && (
                      <input
                        type={sourceField?.type === 'date' ? 'date' : 'number'}
                        value={rule.valueEnd || ''}
                        onChange={(e) => updateRule(idx, { valueEnd: e.target.value })}
                        placeholder="End value"
                        className="w-full px-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {otherFields.length > 0 && (
        <button
          onClick={addRule}
          className="w-full px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
        >
          + Add Condition
        </button>
      )}

      {otherFields.length === 0 && (
        <p className="text-xs text-hud-cream-mute text-center">
          Add more fields to create conditions
        </p>
      )}
    </div>
  );
}

function FormSettingsPanel({
  settings,
  onUpdate,
  availableFields,
}: {
  settings: FormSettings;
  onUpdate: (updates: Partial<FormSettings>) => void;
  availableFields: { id: string; label: string }[];
}) {
  const [activeSection, setActiveSection] = useState<'theme' | 'submission' | 'logic' | 'contacts' | 'spam' | 'notifications'>('theme');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 p-1 bg-hud-bg-elev rounded-lg">
        {[
          { id: 'theme', label: 'Theme' },
          { id: 'submission', label: 'Submit' },
          { id: 'logic', label: 'Logic' },
          { id: 'contacts', label: 'Contacts' },
          { id: 'spam', label: 'Spam' },
          { id: 'notifications', label: 'Notify' },
        ].map((section) => (
          <button
            key={section.id}
            onClick={() => setActiveSection(section.id as typeof activeSection)}
            className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeSection === section.id ? 'bg-hud-bg-card text-white shadow-sm' : 'text-hud-cream-dim hover:text-white'
            }`}
          >
            {section.label}
          </button>
        ))}
      </div>

      {activeSection === 'theme' && (
        <ThemePicker
          value={settings.theme}
          onChange={(theme) => onUpdate({ theme })}
        />
      )}

      {activeSection === 'logic' && (
        <SubmitRulesEditor
          rules={settings.submitRules || []}
          onChange={(submitRules) => onUpdate({ submitRules })}
          availableFields={availableFields}
        />
      )}

      {activeSection === 'submission' && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Success Action</label>
            <select
              value={settings.successAction || 'message'}
              onChange={(e) => onUpdate({ successAction: e.target.value as FormSettings['successAction'] })}
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="message">Show message</option>
              <option value="redirect">Redirect to URL</option>
              <option value="both">Show message, then redirect</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Thank You Message</label>
            <textarea
              value={settings.thankYouMessage || ''}
              onChange={(e) => onUpdate({ thankYouMessage: e.target.value })}
              rows={3}
              placeholder="Thank you for your submission!"
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {(settings.successAction === 'redirect' || settings.successAction === 'both') && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Redirect URL</label>
              <input
                type="url"
                value={settings.redirectUrl || ''}
                onChange={(e) => onUpdate({ redirectUrl: e.target.value })}
                placeholder="https://..."
                className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
        </div>
      )}

      {activeSection === 'contacts' && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Contact Matching</label>
            <select
              value={settings.contactMatching}
              onChange={(e) => onUpdate({ contactMatching: e.target.value as FormSettings['contactMatching'] })}
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="email_first">Match by Email first</option>
              <option value="phone_first">Match by Phone first</option>
              <option value="create_new">Always create new</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Field Overwrite</label>
            <select
              value={settings.fieldOverwrite}
              onChange={(e) => onUpdate({ fieldOverwrite: e.target.value as FormSettings['fieldOverwrite'] })}
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="always">Always overwrite</option>
              <option value="only_if_empty">Only if empty</option>
            </select>
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.stickyContact || false}
              onChange={(e) => onUpdate({ stickyContact: e.target.checked })}
              className="mt-0.5 rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-hud-cream-soft">
              Sticky contact (auto-prefill repeat visitors)
              <span className="block text-xs text-hud-cream-dim mt-0.5">Stores the last submission in the visitor's browser and prefills the form on return.</span>
            </span>
          </label>

          <div className="pt-2 border-t border-hud-bg-elev">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.doubleOptInEnabled || false}
                onChange={(e) => onUpdate({ doubleOptInEnabled: e.target.checked })}
                className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-hud-cream-soft">Enable double opt-in</span>
            </label>
            <p className="text-xs text-hud-cream-dim mt-1 ml-6">
              Send confirmation email before creating contact
            </p>
          </div>
        </div>
      )}

      {activeSection === 'spam' && (
        <div className="space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.honeypotEnabled ?? true}
              onChange={(e) => onUpdate({ honeypotEnabled: e.target.checked })}
              className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-hud-cream-soft">Honeypot field</span>
          </label>

          <div className="pt-2 border-t border-hud-bg-elev">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.captchaEnabled || false}
                onChange={(e) =>
                  onUpdate({
                    captchaEnabled: e.target.checked,
                    captchaProvider: e.target.checked ? 'hcaptcha' : undefined,
                  })
                }
                className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-hud-cream-soft">Enable hCaptcha</span>
            </label>

            {settings.captchaEnabled && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">hCaptcha Site Key</label>
                  <input
                    type="text"
                    value={settings.captchaSiteKey || ''}
                    onChange={(e) => onUpdate({ captchaSiteKey: e.target.value })}
                    placeholder="10000000-ffff-ffff-ffff-000000000001"
                    className="w-full px-3 py-2 text-sm font-mono border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-hud-cream-dim mt-1">
                    The matching <code>HCAPTCHA_SECRET</code> must be set as a Supabase edge function secret.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-hud-bg-elev">
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Rate Limit (per IP)</label>
            <select
              value={settings.rateLimitPerIp || 0}
              onChange={(e) => onUpdate({ rateLimitPerIp: parseInt(e.target.value) })}
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={0}>No limit</option>
              <option value={1}>1 per hour</option>
              <option value={3}>3 per hour</option>
              <option value={5}>5 per hour</option>
              <option value={10}>10 per hour</option>
            </select>
          </div>
        </div>
      )}

      {activeSection === 'notifications' && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Notification Emails</label>
            <textarea
              value={(settings.notificationEmails || []).join('\n')}
              onChange={(e) => onUpdate({
                notificationEmails: e.target.value.split('\n').filter(Boolean)
              })}
              rows={3}
              placeholder="email@example.com&#10;another@example.com"
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-hud-cream-dim mt-1">One email per line</p>
          </div>

          <div className="pt-2 border-t border-hud-bg-elev">
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Webhook URL</label>
            <input
              type="url"
              value={settings.webhookUrl || ''}
              onChange={(e) => onUpdate({ webhookUrl: e.target.value })}
              placeholder="https://..."
              className="w-full px-3 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-hud-cream-dim mt-1">POST submission data to this URL</p>
          </div>
        </div>
      )}
    </div>
  );
}

function FormPreview({ form }: { form: Form }) {
  const getWidthClass = (width: FormField['width']) => {
    switch (width) {
      case 'third': return 'w-1/3 inline-block align-top pr-2';
      case 'half': return 'w-1/2 inline-block align-top pr-2';
      case 'two_thirds': return 'w-2/3 inline-block align-top pr-2';
      default: return 'w-full';
    }
  };

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-8">
        <h2 className="text-2xl font-semibold text-white mb-2">{form.name}</h2>
        {form.description && <p className="text-hud-cream-dim mb-6">{form.description}</p>}

        <div className="space-y-4">
          {form.definition.fields.map((field) => (
            <div key={field.id} className={getWidthClass(field.width)}>
              {field.type === 'divider' ? (
                <div className="py-4">
                  <hr className="border-hud-bg-elev" />
                  {field.label && (
                    <p className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider mt-4">{field.label}</p>
                  )}
                </div>
              ) : field.type === 'column' ? (
                <div className="grid gap-3 py-2" style={{ gridTemplateColumns: `repeat(${field.columnCount || 2}, minmax(0, 1fr))` }}>
                  {Array.from({ length: field.columnCount || 2 }).map((_, i) => (
                    <div key={i} className="border border-dashed border-hud-bg-elev rounded-lg p-4 text-center text-xs text-hud-cream-mute">
                      Column {i + 1}
                    </div>
                  ))}
                </div>
              ) : field.type === 'custom_html' ? (
                <div
                  className="prose prose-sm max-w-none border border-dashed border-hud-bg-elev rounded-lg p-3"
                  dangerouslySetInnerHTML={{ __html: field.htmlContent || '<p class="text-hud-cream-mute text-sm">Custom HTML</p>' }}
                />
              ) : field.type === 'hidden' ? null : (
                <>
                  {field.type !== 'checkbox' && field.type !== 'consent' && (
                    <label className="block text-sm font-medium text-hud-cream-soft mb-1">
                      {field.label}
                      {field.required && <span className="text-hud-plum ml-1">*</span>}
                    </label>
                  )}
                  {field.helpText && (
                    <p className="text-xs text-hud-cream-dim mb-1">{field.helpText}</p>
                  )}

                  {field.type === 'textarea' ? (
                    <textarea
                      placeholder={field.placeholder}
                      rows={4}
                      maxLength={field.characterLimit}
                      className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : field.type === 'textbox_list' ? (
                    <div className="space-y-2">
                      {(field.options || [{ label: 'Item', value: '' }]).map((_, i) => (
                        <input
                          key={i}
                          type="text"
                          placeholder={`Item ${i + 1}`}
                          className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      ))}
                    </div>
                  ) : field.type === 'dropdown' || field.type === 'product_selection' ? (
                    <select className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">{field.placeholder || 'Select...'}</option>
                      {(field.options || []).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : field.type === 'multi_dropdown' ? (
                    <select multiple size={Math.min(5, (field.options || []).length || 3)} className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {(field.options || []).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : field.type === 'state' ? (
                    <select className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">{field.placeholder || 'Select state...'}</option>
                      {US_STATES.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : field.type === 'country' ? (
                    <select className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">{field.placeholder || 'Select country...'}</option>
                      {COUNTRIES.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : field.type === 'timezone' ? (
                    <select className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">{field.placeholder || 'Select timezone...'}</option>
                      {COMMON_TIMEZONES.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : field.type === 'radio' ? (
                    <div className="space-y-2">
                      {(field.options || []).map((opt) => (
                        <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name={field.id}
                            value={opt.value}
                            className="text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-hud-cream-soft">{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  ) : field.type === 'multi_select' || field.type === 'checkbox_group' ? (
                    <div className="space-y-2">
                      {(field.options || []).map((opt) => (
                        <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500" />
                          <span className="text-sm text-hud-cream-soft">{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  ) : field.type === 'checkbox' || field.type === 'consent' ? (
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input type="checkbox" className="rounded border-hud-bg-elev text-blue-600 focus:ring-blue-500 mt-0.5" />
                      <span className="text-sm text-hud-cream-soft">{field.label}</span>
                    </label>
                  ) : field.type === 'file_upload' ? (
                    <div className="border-2 border-dashed border-hud-bg-elev rounded-lg p-6 text-center hover:border-hud-cream-dim transition-colors cursor-pointer">
                      <Upload className="w-8 h-8 mx-auto text-hud-cream-mute mb-2" />
                      <p className="text-sm text-hud-cream-dim">Click to upload or drag and drop</p>
                      <p className="text-xs text-hud-cream-mute mt-1">
                        Max {Math.round((field.fileUploadConfig?.maxSizeBytes || 10485760) / 1048576)}MB
                      </p>
                    </div>
                  ) : field.type === 'monetary' ? (
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-dim text-sm">{currencySymbol(field.currency)}</span>
                      <input
                        type="number"
                        step="0.01"
                        placeholder={field.placeholder || '0.00'}
                        className="w-full pl-8 pr-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  ) : field.type === 'payment' ? (
                    <div className="border border-hud-bg-elev rounded-lg p-4 bg-hud-bg-card/50 text-sm text-hud-cream-dim">
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-4 h-4" />
                        <span>Payment field — connect Stripe to collect payments here.</span>
                      </div>
                    </div>
                  ) : field.type === 'sms_verification' ? (
                    <div className="space-y-2">
                      <input type="tel" placeholder="Phone number" className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <div className="flex gap-2">
                        <input type="text" placeholder="Verification code" className="flex-1 px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        <button type="button" className="px-3 py-2 text-sm bg-hud-bg-elev text-hud-cream-soft rounded-lg hover:bg-hud-cream-mute">Send code</button>
                      </div>
                    </div>
                  ) : field.type === 'email_validation' ? (
                    <div className="flex gap-2">
                      <input type="email" placeholder={field.placeholder || 'you@example.com'} className="flex-1 px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <button type="button" className="px-3 py-2 text-sm bg-hud-bg-elev text-hud-cream-soft rounded-lg hover:bg-hud-cream-mute">Verify</button>
                    </div>
                  ) : field.type === 'math_calculation' ? (
                    <input type="text" readOnly placeholder={field.formula ? `= ${field.formula}` : 'Computed value'} className="w-full px-4 py-2 bg-hud-bg-card/50 border border-hud-bg-elev rounded-lg text-hud-cream-dim" />
                  ) : (
                    <input
                      type={
                        field.type === 'email' ? 'email' :
                        field.type === 'phone' ? 'tel' :
                        field.type === 'number' ? 'number' :
                        field.type === 'date' ? 'date' :
                        field.type === 'website' ? 'url' :
                        'text'
                      }
                      placeholder={field.placeholder}
                      maxLength={field.characterLimit}
                      className="w-full px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}
                </>
              )}
            </div>
          ))}

          <button type="button" className="w-full px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors">
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
