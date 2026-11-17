import { useState, useEffect } from 'react';
import { Plus, FileText, MoreVertical, Pencil, Trash2, History, X, Info, Lock } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import * as promptsService from '../../../services/promptTemplates';
import type {
  PromptTemplate,
  PromptTemplateVersion,
  PromptStatus,
  PromptCategory,
} from '../../../types';
import { PROMPT_CATEGORY_LABELS, COMMON_PROMPT_VARIABLES } from '../../../types';
import { Portal } from '../../shared/Portal';
import { AnchoredMenu } from '../../shared/AnchoredMenu';

interface PromptsSettingsTabProps {
  isViewOnly?: boolean;
}

export function PromptsSettingsTab({ isViewOnly = false }: PromptsSettingsTabProps) {
  const { user } = useAuth();
  const orgId = user?.organization_id;
  const isAdmin = user?.role?.name === 'SuperAdmin' || user?.role?.name === 'Admin';
  const canEdit = isAdmin && !isViewOnly;

  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('all');

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate | null>(null);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [versions, setVersions] = useState<PromptTemplateVersion[]>([]);

  useEffect(() => {
    if (orgId) {
      loadTemplates();
    }
  }, [orgId]);

  const loadTemplates = async () => {
    if (!orgId) return;
    try {
      setLoading(true);
      const data = await promptsService.getTemplates(orgId);
      setTemplates(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setSelectedTemplate(null);
    setIsDrawerOpen(true);
  };

  const handleEdit = (template: PromptTemplate) => {
    setSelectedTemplate(template);
    setIsDrawerOpen(true);
    setOpenMenuId(null);
  };

  const handleToggleStatus = async (template: PromptTemplate) => {
    try {
      const newStatus: PromptStatus = template.status === 'active' ? 'inactive' : 'active';
      await promptsService.toggleTemplateStatus(template.id, newStatus);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update template');
    }
    setOpenMenuId(null);
  };

  const handleDelete = async (template: PromptTemplate) => {
    if (!confirm(`Are you sure you want to delete "${template.name}"?`)) return;
    try {
      await promptsService.deleteTemplate(template.id);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    }
    setOpenMenuId(null);
  };

  const handleViewHistory = async (template: PromptTemplate) => {
    try {
      const versionHistory = await promptsService.getVersions(template.id);
      setVersions(versionHistory);
      setSelectedTemplate(template);
      setShowVersionHistory(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load version history');
    }
    setOpenMenuId(null);
  };

  const handleSave = async () => {
    setIsDrawerOpen(false);
    setSelectedTemplate(null);
    await loadTemplates();
  };

  const filteredTemplates =
    filterCategory === 'all'
      ? templates
      : templates.filter((t) => t.category === filterCategory);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-hud-plum/10 border border-hud-plum/20 rounded-lg p-4 text-hud-plum">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-white">Prompt Templates</h2>
          <p className="text-sm text-hud-cream-dim">
            Create reusable prompt blocks that can be attached to AI agents
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm"
          >
            <option value="all">All Categories</option>
            {Object.entries(PROMPT_CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          {canEdit && (
            <button
              onClick={handleCreate}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create Template
            </button>
          )}
        </div>
      </div>

      {isViewOnly && (
        <div className="bg-hud-bg-card/50 border border-hud-bg-elev rounded-lg p-4 flex items-center gap-3">
          <Lock className="w-5 h-5 text-hud-cream-dim shrink-0" />
          <p className="text-hud-cream-dim text-sm">
            You have view-only access. Contact an administrator to make changes.
          </p>
        </div>
      )}

      {filteredTemplates.length === 0 ? (
        <div className="text-center py-12 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
          <FileText className="w-12 h-12 text-hud-cream-mute mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">No prompt templates</h3>
          <p className="text-hud-cream-dim mb-4">
            {canEdit
              ? 'Create reusable prompts that can be attached to AI agents'
              : 'No prompt templates have been created yet'}
          </p>
          {canEdit && (
            <button
              onClick={handleCreate}
              className="inline-flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep"
            >
              <Plus className="w-4 h-4" />
              Create Template
            </button>
          )}
        </div>
      ) : (
        <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-hud-bg-elev">
                <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Name</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Category</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Variables</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Status</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Agents</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filteredTemplates.map((template) => (
                <tr
                  key={template.id}
                  className="border-b border-hud-bg-elev/50 last:border-0 hover:bg-hud-bg-elev/30"
                >
                  <td className="px-4 py-3">
                    <span className="font-medium text-white">{template.name}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-hud-cream-soft">
                    {PROMPT_CATEGORY_LABELS[template.category]}
                  </td>
                  <td className="px-4 py-3 text-sm text-hud-cream-dim">
                    {template.latest_version?.variables?.length || 0} variables
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                        template.status === 'active'
                          ? 'bg-hud-emerald/10 text-hud-emerald'
                          : 'bg-hud-cream-mute/10 text-hud-cream-dim'
                      }`}
                    >
                      {template.status === 'active' ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-hud-cream-dim">
                    {template.agent_count || 0}
                  </td>
                  <td className="px-4 py-3">
                    <div className="relative">
                      <button
                        onClick={() =>
                          setOpenMenuId(openMenuId === template.id ? null : template.id)
                        }
                        className="p-1 text-hud-cream-dim hover:text-white rounded"
                      >
                        <MoreVertical className="w-5 h-5" />
                      </button>

                      {openMenuId === template.id && (
                        <AnchoredMenu className="w-40 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50">
                          {canEdit && (
                            <button
                              onClick={() => handleEdit(template)}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                            >
                              <Pencil className="w-4 h-4" />
                              Edit
                            </button>
                          )}
                          <button
                            onClick={() => handleViewHistory(template)}
                            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                          >
                            <History className="w-4 h-4" />
                            Version History
                          </button>
                          {canEdit && (
                            <>
                              <button
                                onClick={() => handleToggleStatus(template)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                              >
                                {template.status === 'active' ? 'Deactivate' : 'Activate'}
                              </button>
                              <button
                                onClick={() => handleDelete(template)}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-bg-elev hover:text-hud-plum/40"
                              >
                                <Trash2 className="w-4 h-4" />
                                Delete
                              </button>
                            </>
                          )}
                        </AnchoredMenu>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {isDrawerOpen && (
        <PromptEditorDrawer
          template={selectedTemplate}
          onClose={() => {
            setIsDrawerOpen(false);
            setSelectedTemplate(null);
          }}
          onSave={handleSave}
        />
      )}

      {showVersionHistory && selectedTemplate && (
        <VersionHistoryModal
          template={selectedTemplate}
          versions={versions}
          onClose={() => {
            setShowVersionHistory(false);
            setSelectedTemplate(null);
            setVersions([]);
          }}
        />
      )}
    </div>
  );
}

interface PromptEditorDrawerProps {
  template: PromptTemplate | null;
  onClose: () => void;
  onSave: () => void;
}

function PromptEditorDrawer({ template, onClose, onSave }: PromptEditorDrawerProps) {
  const { user } = useAuth();
  const orgId = user?.organization_id;

  const [name, setName] = useState(template?.name || '');
  const [category, setCategory] = useState<PromptCategory>(template?.category || 'custom');
  const [body, setBody] = useState('');
  const [detectedVariables, setDetectedVariables] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [showVariableHelper, setShowVariableHelper] = useState(false);

  useEffect(() => {
    if (template) {
      loadLatestContent();
    }
  }, [template]);

  useEffect(() => {
    const variables = promptsService.parseVariables(body);
    setDetectedVariables(variables);
  }, [body]);

  const loadLatestContent = async () => {
    if (!template) return;
    try {
      setLoadingContent(true);
      const latest = await promptsService.getLatestVersion(template.id);
      if (latest?.body) {
        setBody(latest.body);
      }
    } catch (err) {
      console.error('Failed to load content:', err);
    } finally {
      setLoadingContent(false);
    }
  };

  const insertVariable = (variable: string) => {
    setBody((prev) => prev + `{{${variable}}}`);
    setShowVariableHelper(false);
  };

  const handleSave = async () => {
    if (!orgId || !user) return;
    if (!name.trim() || !body.trim()) {
      setError('Name and body are required');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (template) {
        await promptsService.updateTemplate(template.id, {
          name: name.trim(),
          category,
        });

        const latestVersion = await promptsService.getLatestVersion(template.id);
        if (body.trim() !== (latestVersion?.body || '').trim()) {
          await promptsService.createVersion(template.id, { body }, user.id);
        }
      } else {
        await promptsService.createTemplate(
          orgId,
          {
            name: name.trim(),
            category,
            body,
          },
          user.id
        );
      }

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex justify-end z-50">
      <div className="w-full max-w-2xl bg-hud-bg-mid h-full overflow-y-auto">
        <div className="sticky top-0 bg-hud-bg-mid border-b border-hud-bg-elev px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-xl font-semibold text-white">
            {template ? 'Edit Template' : 'Create Template'}
          </h2>
          <button onClick={onClose} className="text-hud-cream-dim hover:text-white">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="bg-hud-plum/10 border border-hud-plum/20 rounded-lg p-4 text-hud-plum">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                placeholder="e.g., Lead Qualification"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as PromptCategory)}
                className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
              >
                {Object.entries(PROMPT_CATEGORY_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-hud-cream-soft">Prompt Body *</label>
              <div className="relative">
                <button
                  onClick={() => setShowVariableHelper(!showVariableHelper)}
                  className="flex items-center gap-1 text-xs text-hud-gold-soft hover:text-hud-gold-soft"
                >
                  <Info className="w-3 h-3" />
                  Insert Variable
                </button>

                {showVariableHelper && (
                  <AnchoredMenu className="w-64 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50 p-2 max-h-64 overflow-y-auto">
                    {COMMON_PROMPT_VARIABLES.map((v) => (
                      <button
                        key={v.key}
                        onClick={() => insertVariable(v.key)}
                        className="w-full text-left px-2 py-1.5 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded"
                      >
                        <span className="font-mono text-hud-gold-soft">{`{{${v.key}}}`}</span>
                        <span className="text-hud-cream-mute text-xs block">{v.description}</span>
                      </button>
                    ))}
                  </AnchoredMenu>
                )}
              </div>
            </div>
            <p className="text-xs text-hud-cream-dim mb-2">
              Use {'{{variable_name}}'} syntax to define dynamic variables
            </p>
            {loadingContent ? (
              <div className="h-64 flex items-center justify-center bg-hud-bg-card border border-hud-bg-elev rounded-lg">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold" />
              </div>
            ) : (
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold font-mono text-sm"
                placeholder="Enter your prompt template here...

Use {{contact_name}}, {{contact_email}}, etc. for dynamic values."
              />
            )}
          </div>

          {detectedVariables.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Detected Variables ({detectedVariables.length})
              </label>
              <div className="flex flex-wrap gap-2">
                {detectedVariables.map((v) => (
                  <span
                    key={v}
                    className="inline-flex items-center px-2 py-1 bg-hud-gold/10 text-hud-gold-soft text-xs font-mono rounded"
                  >
                    {`{{${v}}}`}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-hud-bg-mid border-t border-hud-bg-elev px-6 py-4 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-hud-cream-soft hover:text-white">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50"
          >
            {saving ? 'Saving...' : template ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}

interface VersionHistoryModalProps {
  template: PromptTemplate;
  versions: PromptTemplateVersion[];
  onClose: () => void;
}

function VersionHistoryModal({ template, versions, onClose }: VersionHistoryModalProps) {
  const [selectedVersion, setSelectedVersion] = useState<PromptTemplateVersion | null>(
    versions[0] || null
  );

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-mid border border-hud-bg-elev rounded-lg w-full max-w-4xl max-h-[80dvh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <h2 className="text-lg font-semibold text-white">
            Version History - {template.name}
          </h2>
          <button onClick={onClose} className="text-hud-cream-dim hover:text-white">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-64 border-r border-hud-bg-elev overflow-y-auto">
            {versions.map((version) => (
              <button
                key={version.id}
                onClick={() => setSelectedVersion(version)}
                className={`w-full text-left px-4 py-3 border-b border-hud-bg-elev/50 ${
                  selectedVersion?.id === version.id
                    ? 'bg-hud-bg-card text-white'
                    : 'text-hud-cream-dim hover:bg-hud-bg-card/50 hover:text-white'
                }`}
              >
                <div className="font-medium">Version {version.version_number}</div>
                <div className="text-xs text-hud-cream-mute">
                  {new Date(version.created_at).toLocaleString()}
                </div>
                {version.variables?.length > 0 && (
                  <div className="text-xs text-hud-gold-soft mt-1">
                    {version.variables.length} variables
                  </div>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {selectedVersion ? (
              <div className="space-y-4">
                {selectedVersion.variables?.length > 0 && (
                  <div className="flex flex-wrap gap-2 pb-4 border-b border-hud-bg-elev">
                    {selectedVersion.variables.map((v) => (
                      <span
                        key={v}
                        className="inline-flex items-center px-2 py-1 bg-hud-gold/10 text-hud-gold-soft text-xs font-mono rounded"
                      >
                        {`{{${v}}}`}
                      </span>
                    ))}
                  </div>
                )}
                <pre className="text-sm text-hud-cream-soft whitespace-pre-wrap font-mono">
                  {selectedVersion.body}
                </pre>
              </div>
            ) : (
              <p className="text-hud-cream-dim">Select a version to view its content</p>
            )}
          </div>
        </div>
      </div>
    </div></Portal>
  );
}
