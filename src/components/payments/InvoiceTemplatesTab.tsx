import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getInvoiceTemplates,
  createInvoiceTemplate,
  updateInvoiceTemplate,
  deleteInvoiceTemplate,
  setDefaultTemplate,
  duplicateTemplate,
  type InvoiceTemplate,
  type CreateInvoiceTemplateInput,
} from '../../services/invoiceTemplates';
import {
  FileText,
  Plus,
  Loader2,
  Star,
  StarOff,
  MoreVertical,
  Copy,
  Trash2,
  Edit3,
  X,
  Check,
  Palette,
} from 'lucide-react';
import { Portal } from '../shared/Portal';
import { AnchoredMenu } from '../shared/AnchoredMenu';

interface InvoiceTemplatesTabProps {
  onRefresh?: () => void;
}

export function InvoiceTemplatesTab({ onRefresh }: InvoiceTemplatesTabProps) {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<InvoiceTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<InvoiceTemplate | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState<CreateInvoiceTemplateInput>({
    name: '',
    description: '',
    is_default: false,
    header_text: '',
    footer_text: 'Thank you for your business!',
    accent_color: '#06b6d4',
    show_payment_instructions: true,
    payment_instructions: '',
    include_due_date: true,
    include_invoice_number: true,
    include_line_item_descriptions: true,
  });

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      setIsLoading(true);
      const data = await getInvoiceTemplates();
      setTemplates(data);
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingTemplate(null);
    setFormData({
      name: '',
      description: '',
      is_default: false,
      header_text: '',
      footer_text: 'Thank you for your business!',
      accent_color: '#06b6d4',
      show_payment_instructions: true,
      payment_instructions: '',
      include_due_date: true,
      include_invoice_number: true,
      include_line_item_descriptions: true,
    });
    setShowEditor(true);
  };

  const handleEdit = (template: InvoiceTemplate) => {
    setEditingTemplate(template);
    setFormData({
      name: template.name,
      description: template.description,
      is_default: template.is_default,
      header_text: template.header_text,
      footer_text: template.footer_text,
      accent_color: template.accent_color,
      show_payment_instructions: template.show_payment_instructions,
      payment_instructions: template.payment_instructions,
      include_due_date: template.include_due_date,
      include_invoice_number: template.include_invoice_number,
      include_line_item_descriptions: template.include_line_item_descriptions,
    });
    setShowEditor(true);
    setActionMenuId(null);
  };

  const handleSave = async () => {
    if (!user || !formData.name.trim()) return;

    try {
      setIsSaving(true);
      if (editingTemplate) {
        await updateInvoiceTemplate(editingTemplate.id, formData);
      } else {
        await createInvoiceTemplate(formData, user);
      }
      await loadTemplates();
      setShowEditor(false);
      onRefresh?.();
    } catch (err) {
      console.error('Failed to save template:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultTemplate(id);
      await loadTemplates();
    } catch (err) {
      console.error('Failed to set default:', err);
    }
    setActionMenuId(null);
  };

  const handleDuplicate = async (template: InvoiceTemplate) => {
    if (!user) return;
    try {
      await duplicateTemplate(template.id, `${template.name} (Copy)`, user);
      await loadTemplates();
    } catch (err) {
      console.error('Failed to duplicate:', err);
    }
    setActionMenuId(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return;
    try {
      await deleteInvoiceTemplate(id);
      await loadTemplates();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
    setActionMenuId(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-white">Invoice Templates</h3>
        <button
          onClick={handleCreate}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="text-center py-12">
          <FileText className="w-12 h-12 text-hud-cream-mute mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">No templates yet</h3>
          <p className="text-hud-cream-dim mb-4">Create your first invoice template to customize your invoices</p>
          <button
            onClick={handleCreate}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create Template
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((template) => (
            <div
              key={template.id}
              className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-5 relative group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: `${template.accent_color}20` }}
                  >
                    <FileText className="w-5 h-5" style={{ color: template.accent_color }} />
                  </div>
                  <div>
                    <h4 className="text-white font-medium flex items-center gap-2">
                      {template.name}
                      {template.is_default && (
                        <Star className="w-4 h-4 text-hud-rust fill-hud-rust" />
                      )}
                    </h4>
                    <p className="text-hud-cream-dim text-sm">{template.description || 'No description'}</p>
                  </div>
                </div>
                <div className="relative">
                  <button
                    onClick={() => setActionMenuId(actionMenuId === template.id ? null : template.id)}
                    className="p-1.5 rounded hover:bg-hud-bg-elev text-hud-cream-dim opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {actionMenuId === template.id && (
                    <AnchoredMenu className="w-48 rounded-lg bg-hud-bg-card border border-hud-bg-elev shadow-xl z-50">
                      <button
                        onClick={() => handleEdit(template)}
                        className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                      >
                        <Edit3 className="w-4 h-4" />
                        Edit
                      </button>
                      {!template.is_default && (
                        <button
                          onClick={() => handleSetDefault(template.id)}
                          className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                        >
                          <Star className="w-4 h-4" />
                          Set as Default
                        </button>
                      )}
                      <button
                        onClick={() => handleDuplicate(template)}
                        className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                      >
                        <Copy className="w-4 h-4" />
                        Duplicate
                      </button>
                      {!template.is_default && (
                        <button
                          onClick={() => handleDelete(template.id)}
                          className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-hud-plum hover:bg-hud-bg-elev"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </button>
                      )}
                    </AnchoredMenu>
                  )}
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-hud-cream-dim">
                  <div
                    className="w-4 h-4 rounded"
                    style={{ backgroundColor: template.accent_color }}
                  />
                  <span>Accent color</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {template.include_invoice_number && (
                    <span className="px-2 py-0.5 rounded bg-hud-bg-elev/50 text-hud-cream-soft text-xs">Invoice #</span>
                  )}
                  {template.include_due_date && (
                    <span className="px-2 py-0.5 rounded bg-hud-bg-elev/50 text-hud-cream-soft text-xs">Due Date</span>
                  )}
                  {template.include_line_item_descriptions && (
                    <span className="px-2 py-0.5 rounded bg-hud-bg-elev/50 text-hud-cream-soft text-xs">Line Items</span>
                  )}
                  {template.show_payment_instructions && (
                    <span className="px-2 py-0.5 rounded bg-hud-bg-elev/50 text-hud-cream-soft text-xs">Payment Info</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showEditor && (
        <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card w-full max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-hud-bg-card">
              <h2 className="text-lg font-semibold text-white">
                {editingTemplate ? 'Edit Template' : 'New Template'}
              </h2>
              <button
                onClick={() => setShowEditor(false)}
                className="p-2 hover:bg-hud-bg-card rounded-lg text-hud-cream-dim hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 space-y-6">
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Template Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Standard Invoice"
                  className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Description
                </label>
                <input
                  type="text"
                  value={formData.description || ''}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Brief description of this template"
                  className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                    Accent Color
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={formData.accent_color}
                      onChange={(e) => setFormData({ ...formData, accent_color: e.target.value })}
                      className="w-10 h-10 rounded cursor-pointer border-0"
                    />
                    <input
                      type="text"
                      value={formData.accent_color}
                      onChange={(e) => setFormData({ ...formData, accent_color: e.target.value })}
                      className="flex-1 px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    />
                  </div>
                </div>

                <div className="flex items-center pt-6">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.is_default}
                      onChange={(e) => setFormData({ ...formData, is_default: e.target.checked })}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                    />
                    <span className="text-sm text-hud-cream-soft">Set as default template</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Header Text
                </label>
                <textarea
                  value={formData.header_text || ''}
                  onChange={(e) => setFormData({ ...formData, header_text: e.target.value })}
                  placeholder="Text to appear at the top of the invoice"
                  rows={2}
                  className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Footer Text
                </label>
                <textarea
                  value={formData.footer_text || ''}
                  onChange={(e) => setFormData({ ...formData, footer_text: e.target.value })}
                  placeholder="Text to appear at the bottom of the invoice"
                  rows={2}
                  className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>

              <div className="space-y-3">
                <label className="block text-sm font-medium text-hud-cream-soft">
                  Include in Invoice
                </label>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.include_invoice_number}
                      onChange={(e) => setFormData({ ...formData, include_invoice_number: e.target.checked })}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                    />
                    <span className="text-sm text-hud-cream-soft">Invoice Number</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.include_due_date}
                      onChange={(e) => setFormData({ ...formData, include_due_date: e.target.checked })}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                    />
                    <span className="text-sm text-hud-cream-soft">Due Date</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.include_line_item_descriptions}
                      onChange={(e) => setFormData({ ...formData, include_line_item_descriptions: e.target.checked })}
                      className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                    />
                    <span className="text-sm text-hud-cream-soft">Line Item Descriptions</span>
                  </label>
                </div>
              </div>

              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.show_payment_instructions}
                    onChange={(e) => setFormData({ ...formData, show_payment_instructions: e.target.checked })}
                    className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                  />
                  <span className="text-sm font-medium text-hud-cream-soft">Show Payment Instructions</span>
                </label>
                {formData.show_payment_instructions && (
                  <textarea
                    value={formData.payment_instructions || ''}
                    onChange={(e) => setFormData({ ...formData, payment_instructions: e.target.value })}
                    placeholder="e.g., Please make checks payable to..."
                    rows={3}
                    className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 p-6 border-t border-hud-bg-card">
              <button
                onClick={() => setShowEditor(false)}
                className="px-4 py-2 rounded-lg text-hud-cream-soft hover:text-white hover:bg-hud-bg-card transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !formData.name.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    {editingTemplate ? 'Update Template' : 'Create Template'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div></Portal>
      )}
    </div>
  );
}
