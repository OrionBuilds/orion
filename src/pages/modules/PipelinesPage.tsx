import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, GripVertical, Trash2, CreditCard as Edit2, Check, ChevronDown, ChevronUp, Settings, Columns2 as Columns, Clock, AlertCircle, X, Eye } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import type { Pipeline, PipelineCustomField } from '../../types';
import * as pipelinesService from '../../services/pipelines';
import { normalizeOptions } from '../../lib/fieldOptions';

export function PipelinesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = usePermission('pipelines.manage');

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'stages' | 'fields'>('stages');

  const [newStageName, setNewStageName] = useState('');
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [editingStageName, setEditingStageName] = useState('');
  const [expandedStageId, setExpandedStageId] = useState<string | null>(null);

  const [newFieldForm, setNewFieldForm] = useState({
    label: '',
    field_key: '',
    field_type: 'text' as PipelineCustomField['field_type'],
    required: false,
    filterable: true,
    options: [] as string[]
  });
  const [showNewFieldForm, setShowNewFieldForm] = useState(false);
  const [newOption, setNewOption] = useState('');

  useEffect(() => {
    if (user?.organization_id) {
      loadData();
    }
  }, [user?.organization_id]);

  async function loadData() {
    if (!user?.organization_id) return;
    try {
      const pipelinesData = await pipelinesService.getPipelines();
      setPipelines(pipelinesData);
      if (pipelinesData.length > 0) {
        await selectPipeline(pipelinesData[0]);
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }

  async function selectPipeline(pipeline: Pipeline) {
    try {
      const fullPipeline = await pipelinesService.getPipelineById(pipeline.id);
      if (fullPipeline) {
        setSelectedPipeline(fullPipeline);
      }
    } catch (error) {
      console.error('Failed to load pipeline:', error);
    }
  }

  async function handleCreateStage() {
    if (!newStageName.trim() || !selectedPipeline || !user) return;
    setSaving(true);
    try {
      const stage = await pipelinesService.createStage({
        org_id: user.organization_id,
        pipeline_id: selectedPipeline.id,
        name: newStageName.trim()
      });
      setSelectedPipeline({
        ...selectedPipeline,
        stages: [...(selectedPipeline.stages || []), stage]
      });
      setNewStageName('');
    } catch (error) {
      console.error('Failed to create stage:', error);
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateStage(stageId: string, name: string) {
    if (!name.trim() || !selectedPipeline) return;
    setSaving(true);
    try {
      await pipelinesService.updateStage(stageId, { name: name.trim() });
      setSelectedPipeline({
        ...selectedPipeline,
        stages: (selectedPipeline.stages || []).map(s =>
          s.id === stageId ? { ...s, name: name.trim() } : s
        )
      });
      setEditingStageId(null);
      setEditingStageName('');
    } catch (error) {
      console.error('Failed to update stage:', error);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteStage(stageId: string) {
    if (!selectedPipeline) return;
    if (!confirm('Delete this stage? Opportunities in this stage will need to be moved first.')) return;
    setSaving(true);
    try {
      await pipelinesService.deleteStage(stageId);
      setSelectedPipeline({
        ...selectedPipeline,
        stages: (selectedPipeline.stages || []).filter(s => s.id !== stageId)
      });
    } catch (error) {
      console.error('Failed to delete stage:', error);
    } finally {
      setSaving(false);
    }
  }

  async function handleMoveStage(stageId: string, direction: 'up' | 'down') {
    if (!selectedPipeline?.stages) return;
    const stages = [...selectedPipeline.stages];
    const idx = stages.findIndex(s => s.id === stageId);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === stages.length - 1) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    [stages[idx], stages[swapIdx]] = [stages[swapIdx], stages[idx]];

    setSelectedPipeline({ ...selectedPipeline, stages });

    try {
      await pipelinesService.reorderStages(selectedPipeline.id, stages.map(s => s.id));
    } catch (error) {
      console.error('Failed to reorder stages:', error);
    }
  }

  async function handleUpdateAgingThreshold(stageId: string, days: number | null) {
    if (!selectedPipeline) return;
    setSaving(true);
    try {
      await pipelinesService.updateStage(stageId, { aging_threshold_days: days });
      setSelectedPipeline({
        ...selectedPipeline,
        stages: (selectedPipeline.stages || []).map(s =>
          s.id === stageId ? { ...s, aging_threshold_days: days } : s
        )
      });
    } catch (error) {
      console.error('Failed to update aging threshold:', error);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateField() {
    if (!newFieldForm.label.trim() || !selectedPipeline || !user) return;
    setSaving(true);
    try {
      const field = await pipelinesService.createCustomField({
        org_id: user.organization_id,
        pipeline_id: selectedPipeline.id,
        field_key: newFieldForm.field_key || newFieldForm.label.toLowerCase().replace(/\s+/g, '_'),
        label: newFieldForm.label.trim(),
        field_type: newFieldForm.field_type,
        required: newFieldForm.required,
        filterable: newFieldForm.filterable,
        options: newFieldForm.options
      });
      setSelectedPipeline({
        ...selectedPipeline,
        custom_fields: [...(selectedPipeline.custom_fields || []), field]
      });
      setNewFieldForm({
        label: '',
        field_key: '',
        field_type: 'text',
        required: false,
        filterable: true,
        options: []
      });
      setShowNewFieldForm(false);
    } catch (error) {
      console.error('Failed to create field:', error);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteField(fieldId: string) {
    if (!selectedPipeline) return;
    if (!confirm('Delete this custom field? Existing values will be lost.')) return;
    setSaving(true);
    try {
      await pipelinesService.deleteCustomField(fieldId);
      setSelectedPipeline({
        ...selectedPipeline,
        custom_fields: (selectedPipeline.custom_fields || []).filter(f => f.id !== fieldId)
      });
    } catch (error) {
      console.error('Failed to delete field:', error);
    } finally {
      setSaving(false);
    }
  }

  function addOption() {
    if (!newOption.trim()) return;
    setNewFieldForm({
      ...newFieldForm,
      options: [...newFieldForm.options, newOption.trim()]
    });
    setNewOption('');
  }

  function removeOption(index: number) {
    setNewFieldForm({
      ...newFieldForm,
      options: newFieldForm.options.filter((_, i) => i !== index)
    });
  }

  function handleViewInBoard(pipelineId: string) {
    navigate(`/opportunities?pipeline=${pipelineId}`);
  }

  const currentStages = selectedPipeline?.stages || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-hud-gold-soft border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <AlertCircle className="w-12 h-12 text-hud-cream-mute mb-4" />
        <h2 className="text-lg font-semibold text-white mb-2">Access Restricted</h2>
        <p className="text-hud-cream-dim">You don't have permission to manage pipelines.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col md:flex-row overflow-y-auto md:overflow-visible">
      <div className="w-full md:w-72 md:flex-shrink-0 max-h-56 md:max-h-none border-b md:border-b-0 md:border-r border-hud-bg-elev bg-hud-bg-card/30 flex flex-col">
        <div className="p-4 border-b border-hud-bg-elev">
          <h2 className="text-sm font-medium text-hud-cream-dim uppercase tracking-wider">Pipelines</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {pipelines.map(pipeline => (
            <div
              key={pipeline.id}
              className={`p-3 rounded-lg cursor-pointer transition-colors ${
                selectedPipeline?.id === pipeline.id
                  ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/30'
                  : 'hover:bg-hud-bg-elev/50 text-hud-cream-soft border border-transparent'
              }`}
              onClick={() => selectPipeline(pipeline)}
            >
              <span className="block truncate font-medium">{pipeline.name}</span>
              <span className="text-xs text-hud-cream-mute mt-0.5 block">
                {pipeline.stages?.length || 0} stages
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col md:overflow-hidden">
        {selectedPipeline ? (
          <>
            <div className="flex-none p-4 border-b border-hud-bg-elev bg-hud-bg-card/30">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-semibold text-white">{selectedPipeline.name}</h3>
                <button
                  onClick={() => handleViewInBoard(selectedPipeline.id)}
                  className="flex items-center gap-2 px-4 py-2 bg-hud-bg-elev text-white rounded-lg hover:bg-hud-cream-mute transition-colors"
                >
                  <Eye className="w-4 h-4" />
                  View in Board
                </button>
              </div>

              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setActiveTab('stages')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === 'stages'
                      ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/30'
                      : 'text-hud-cream-dim hover:bg-hud-bg-elev border border-transparent'
                  }`}
                >
                  <Columns className="w-4 h-4" />
                  Stages
                  <span className="text-xs bg-hud-cream-mute/50 px-1.5 py-0.5 rounded">
                    {currentStages.length}
                  </span>
                </button>
                <button
                  onClick={() => setActiveTab('fields')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === 'fields'
                      ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/30'
                      : 'text-hud-cream-dim hover:bg-hud-bg-elev border border-transparent'
                  }`}
                >
                  <Settings className="w-4 h-4" />
                  Custom Fields
                  <span className="text-xs bg-hud-cream-mute/50 px-1.5 py-0.5 rounded">
                    {selectedPipeline?.custom_fields?.length || 0}
                  </span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {activeTab === 'stages' && (
                <div className="max-w-2xl space-y-2">
                  {currentStages.map((stage, index) => (
                    <div key={stage.id} className="bg-hud-bg-elev/30 rounded-lg border border-hud-bg-elev">
                      <div className="flex items-center gap-3 p-4 group">
                        <GripVertical className="w-4 h-4 text-hud-cream-mute cursor-grab" />
                        {editingStageId === stage.id ? (
                          <div className="flex-1 flex items-center gap-2">
                            <input
                              type="text"
                              value={editingStageName}
                              onChange={(e) => setEditingStageName(e.target.value)}
                              className="flex-1 px-3 py-1.5 bg-hud-cream-mute border border-hud-cream-mute rounded-lg text-white text-sm focus:ring-2 focus:ring-hud-gold"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleUpdateStage(stage.id, editingStageName);
                                if (e.key === 'Escape') {
                                  setEditingStageId(null);
                                  setEditingStageName('');
                                }
                              }}
                            />
                            <button
                              onClick={() => handleUpdateStage(stage.id, editingStageName)}
                              className="p-1.5 hover:bg-hud-cream-mute rounded-lg"
                            >
                              <Check className="w-4 h-4 text-hud-emerald" />
                            </button>
                            <button
                              onClick={() => {
                                setEditingStageId(null);
                                setEditingStageName('');
                              }}
                              className="p-1.5 hover:bg-hud-cream-mute rounded-lg"
                            >
                              <X className="w-4 h-4 text-hud-cream-dim" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex-1">
                              <span className="text-white font-medium">{stage.name}</span>
                              {stage.aging_threshold_days && (
                                <span className="ml-3 text-xs text-hud-rust inline-flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  {stage.aging_threshold_days}d aging threshold
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity">
                              <button
                                onClick={() => setExpandedStageId(expandedStageId === stage.id ? null : stage.id)}
                                className={`p-1.5 hover:bg-hud-cream-mute rounded-lg ${expandedStageId === stage.id ? 'bg-hud-cream-mute' : ''}`}
                                title="Stage settings"
                              >
                                <Settings className="w-4 h-4 text-hud-cream-dim" />
                              </button>
                              <button
                                onClick={() => handleMoveStage(stage.id, 'up')}
                                disabled={index === 0}
                                className="p-1.5 hover:bg-hud-cream-mute rounded-lg disabled:opacity-30"
                              >
                                <ChevronUp className="w-4 h-4 text-hud-cream-dim" />
                              </button>
                              <button
                                onClick={() => handleMoveStage(stage.id, 'down')}
                                disabled={index === currentStages.length - 1}
                                className="p-1.5 hover:bg-hud-cream-mute rounded-lg disabled:opacity-30"
                              >
                                <ChevronDown className="w-4 h-4 text-hud-cream-dim" />
                              </button>
                              <button
                                onClick={() => {
                                  setEditingStageId(stage.id);
                                  setEditingStageName(stage.name);
                                }}
                                className="p-1.5 hover:bg-hud-cream-mute rounded-lg"
                              >
                                <Edit2 className="w-4 h-4 text-hud-cream-dim" />
                              </button>
                              <button
                                onClick={() => handleDeleteStage(stage.id)}
                                className="p-1.5 hover:bg-hud-cream-mute rounded-lg"
                              >
                                <Trash2 className="w-4 h-4 text-hud-plum" />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                      {expandedStageId === stage.id && (
                        <div className="px-4 pb-4 pt-1 border-t border-hud-cream-mute">
                          <div className="flex items-center gap-3 mt-3">
                            <label className="text-sm text-hud-cream-dim whitespace-nowrap">
                              Stale after
                            </label>
                            <input
                              type="number"
                              min="0"
                              value={stage.aging_threshold_days || ''}
                              onChange={(e) => {
                                const val = e.target.value ? parseInt(e.target.value, 10) : null;
                                handleUpdateAgingThreshold(stage.id, val);
                              }}
                              placeholder="No limit"
                              className="w-24 px-3 py-1.5 bg-hud-cream-mute border border-hud-cream-mute rounded-lg text-white text-sm"
                            />
                            <span className="text-sm text-hud-cream-dim">days</span>
                            {stage.aging_threshold_days && (
                              <button
                                onClick={() => handleUpdateAgingThreshold(stage.id, null)}
                                className="text-xs text-hud-cream-mute hover:text-hud-cream-soft"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <p className="text-xs text-hud-cream-mute mt-2">
                            Opportunities in this stage longer than this threshold will show an aging warning
                          </p>
                        </div>
                      )}
                    </div>
                  ))}

                  <div className="flex items-center gap-2 pt-4">
                    <input
                      type="text"
                      value={newStageName}
                      onChange={(e) => setNewStageName(e.target.value)}
                      placeholder="New stage name"
                      className="flex-1 px-4 py-2.5 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateStage()}
                    />
                    <button
                      onClick={handleCreateStage}
                      disabled={saving || !newStageName.trim()}
                      className="px-4 py-2.5 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'fields' && selectedPipeline && (
                <div className="max-w-2xl space-y-3">
                  {(selectedPipeline.custom_fields || []).length === 0 && !showNewFieldForm && (
                    <div className="text-center py-8 text-hud-cream-dim">
                      <Settings className="w-12 h-12 mx-auto mb-3 text-hud-cream-mute" />
                      <p>No custom fields configured</p>
                      <p className="text-sm text-hud-cream-mute mt-1">Add custom fields to capture additional data on opportunities</p>
                    </div>
                  )}

                  {(selectedPipeline.custom_fields || []).map(field => (
                    <div
                      key={field.id}
                      className="flex items-center justify-between p-4 bg-hud-bg-elev/30 rounded-lg border border-hud-bg-elev"
                    >
                      <div>
                        <div className="text-white font-medium">{field.label}</div>
                        <div className="text-sm text-hud-cream-dim mt-0.5">
                          Type: {field.field_type}
                          {field.required && <span className="ml-2 text-hud-rust">(required)</span>}
                          {field.filterable && <span className="ml-2 text-hud-gold-soft">(filterable)</span>}
                        </div>
                        {field.options && field.options.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {normalizeOptions(field.options).map((opt, i) => (
                              <span key={i} className="px-2 py-0.5 bg-hud-cream-mute rounded text-xs text-hud-cream-soft">
                                {opt.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteField(field.id)}
                        className="p-2 hover:bg-hud-cream-mute rounded-lg"
                      >
                        <Trash2 className="w-4 h-4 text-hud-plum" />
                      </button>
                    </div>
                  ))}

                  {showNewFieldForm ? (
                    <div className="p-4 bg-hud-bg-elev/30 rounded-lg border border-hud-bg-elev space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">Label</label>
                        <input
                          type="text"
                          value={newFieldForm.label}
                          onChange={(e) => setNewFieldForm({ ...newFieldForm, label: e.target.value })}
                          className="w-full px-4 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white focus:ring-2 focus:ring-hud-gold"
                          placeholder="e.g., Lead Source"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">Field Type</label>
                        <select
                          value={newFieldForm.field_type}
                          onChange={(e) => setNewFieldForm({
                            ...newFieldForm,
                            field_type: e.target.value as PipelineCustomField['field_type']
                          })}
                          className="w-full px-4 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white focus:ring-2 focus:ring-hud-gold"
                        >
                          <option value="text">Text</option>
                          <option value="number">Number</option>
                          <option value="date">Date</option>
                          <option value="dropdown">Dropdown</option>
                          <option value="multi_select">Multi Select</option>
                          <option value="boolean">Checkbox</option>
                        </select>
                      </div>

                      {(newFieldForm.field_type === 'dropdown' || newFieldForm.field_type === 'multi_select') && (
                        <div>
                          <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">Options</label>
                          <div className="space-y-2">
                            {newFieldForm.options.map((opt, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <span className="flex-1 px-3 py-2 bg-hud-cream-mute rounded-lg text-sm text-white">{opt}</span>
                                <button
                                  onClick={() => removeOption(i)}
                                  className="p-2 hover:bg-hud-cream-mute rounded-lg"
                                >
                                  <X className="w-4 h-4 text-hud-plum" />
                                </button>
                              </div>
                            ))}
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={newOption}
                                onChange={(e) => setNewOption(e.target.value)}
                                placeholder="Add option"
                                className="flex-1 px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white text-sm"
                                onKeyDown={(e) => e.key === 'Enter' && addOption()}
                              />
                              <button
                                onClick={addOption}
                                className="px-4 py-2 bg-hud-cream-mute text-white rounded-lg text-sm hover:bg-hud-cream-mute"
                              >
                                Add
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-6">
                        <label className="flex items-center gap-2 text-sm text-hud-cream-soft cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newFieldForm.required}
                            onChange={(e) => setNewFieldForm({ ...newFieldForm, required: e.target.checked })}
                            className="rounded bg-hud-bg-elev border-hud-cream-mute text-hud-gold focus:ring-hud-gold"
                          />
                          Required
                        </label>
                        <label className="flex items-center gap-2 text-sm text-hud-cream-soft cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newFieldForm.filterable}
                            onChange={(e) => setNewFieldForm({ ...newFieldForm, filterable: e.target.checked })}
                            className="rounded bg-hud-bg-elev border-hud-cream-mute text-hud-gold focus:ring-hud-gold"
                          />
                          Filterable
                        </label>
                      </div>

                      <div className="flex gap-3 pt-2">
                        <button
                          onClick={handleCreateField}
                          disabled={saving || !newFieldForm.label.trim()}
                          className="flex-1 px-4 py-2.5 bg-hud-gold-deep text-white rounded-lg font-medium hover:bg-hud-gold-deep disabled:opacity-50"
                        >
                          Create Field
                        </button>
                        <button
                          onClick={() => {
                            setShowNewFieldForm(false);
                            setNewFieldForm({
                              label: '',
                              field_key: '',
                              field_type: 'text',
                              required: false,
                              filterable: true,
                              options: []
                            });
                          }}
                          className="px-4 py-2.5 bg-hud-cream-mute text-white rounded-lg hover:bg-hud-cream-mute"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewFieldForm(true)}
                      className="flex items-center gap-2 px-4 py-2.5 bg-hud-bg-elev text-hud-cream-soft rounded-lg hover:bg-hud-cream-mute transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Add Custom Field
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-hud-cream-dim">
            <Columns className="w-16 h-16 mb-4 text-hud-cream-mute" />
            <p className="text-lg font-medium text-white">No Pipeline Selected</p>
            <p className="text-sm mt-1">Select a pipeline from the sidebar</p>
          </div>
        )}
      </div>
    </div>
  );
}
