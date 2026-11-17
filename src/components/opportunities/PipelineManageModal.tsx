import { useState, useEffect } from 'react';
import { X, Plus, GripVertical, Trash2, CreditCard as Edit2, Check, ChevronDown, ChevronUp, Settings, Columns2 as Columns, Clock } from 'lucide-react';
import type { Pipeline, PipelineCustomField } from '../../types';
import * as pipelinesService from '../../services/pipelines';
import { usePermission } from '../../hooks/usePermission';
import { Portal } from '../shared/Portal';
import { DeletePipelineModal } from './DeletePipelineModal';

interface PipelineManageModalProps {
  orgId: string;
  onClose: () => void;
  onPipelineSelect?: (pipeline: Pipeline) => void;
}

export function PipelineManageModal({ orgId, onClose, onPipelineSelect }: PipelineManageModalProps) {
  // Same permission that gates the Manage button on the board and list pages.
  const canManagePipelines = usePermission('pipelines.manage');
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'stages' | 'fields'>('stages');

  const [newStageName, setNewStageName] = useState('');
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [editingStageName, setEditingStageName] = useState('');
  const [expandedStageId, setExpandedStageId] = useState<string | null>(null);

  const [editingPipelineName, setEditingPipelineName] = useState<string | null>(null);
  const [showDeletePipeline, setShowDeletePipeline] = useState(false);
  const [pipelineError, setPipelineError] = useState('');

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
    if (orgId) {
      loadData();
    }
  }, [orgId]);

  async function loadData() {
    if (!orgId) return;
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
    setEditingPipelineName(null);
    setPipelineError('');
    try {
      const fullPipeline = await pipelinesService.getPipelineById(pipeline.id);
      if (fullPipeline) {
        setSelectedPipeline(fullPipeline);
      }
    } catch (error) {
      console.error('Failed to load pipeline:', error);
    }
  }

  async function handleRenamePipeline() {
    if (!selectedPipeline || editingPipelineName === null) return;
    const name = editingPipelineName.trim();
    if (!name || name === selectedPipeline.name) {
      setEditingPipelineName(null);
      return;
    }
    if (pipelines.some(p => p.id !== selectedPipeline.id && p.name.toLowerCase() === name.toLowerCase())) {
      setPipelineError(`A pipeline named "${name}" already exists.`);
      return;
    }
    setSaving(true);
    setPipelineError('');
    try {
      await pipelinesService.updatePipeline(selectedPipeline.id, { name });
      setSelectedPipeline({ ...selectedPipeline, name });
      setPipelines(pipelines.map(p => (p.id === selectedPipeline.id ? { ...p, name } : p)));
      setEditingPipelineName(null);
    } catch (error) {
      console.error('Failed to rename pipeline:', error);
      const code = (error as { code?: string } | null)?.code;
      setPipelineError(code === '23505' ? `A pipeline named "${name}" already exists.` : 'Failed to rename pipeline.');
    } finally {
      setSaving(false);
    }
  }

  async function handlePipelineDeleted(pipelineId: string) {
    setShowDeletePipeline(false);
    const remaining = pipelines.filter(p => p.id !== pipelineId);
    setPipelines(remaining);
    setSelectedPipeline(null);
    if (remaining.length > 0) {
      await selectPipeline(remaining[0]);
    }
  }

  async function handleCreateStage() {
    if (!newStageName.trim() || !selectedPipeline) return;
    setSaving(true);
    try {
      const stage = await pipelinesService.createStage({
        org_id: orgId,
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
    setPipelineError('');
    // opportunities.stage_id is ON DELETE RESTRICT; say so up front instead of failing silently.
    try {
      const count = await pipelinesService.countStageOpportunities(stageId);
      if (count > 0) {
        const stageName = selectedPipeline.stages?.find(s => s.id === stageId)?.name ?? 'This stage';
        setPipelineError(
          `"${stageName}" still has ${count} opportunit${count === 1 ? 'y' : 'ies'}. Move them to another stage before deleting it.`
        );
        return;
      }
    } catch (error) {
      console.error('Failed to count stage opportunities:', error);
    }
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
      setPipelineError('Failed to delete stage.');
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
    if (!newFieldForm.label.trim() || !selectedPipeline) return;
    setSaving(true);
    try {
      const field = await pipelinesService.createCustomField({
        org_id: orgId,
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

  const currentStages = selectedPipeline?.stages || [];

  if (loading) {
    return (
      <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-hud-bg-card rounded-xl p-8">
          <div className="animate-spin w-8 h-8 border-2 border-hud-gold-soft border-t-transparent rounded-full" />
        </div>
      </div></Portal>
    );
  }

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-card rounded-xl w-full max-w-4xl max-h-[90dvh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev">
          <h2 className="text-lg font-semibold text-white">Manage Pipelines</h2>
          <button onClick={onClose} className="p-1 hover:bg-hud-bg-elev rounded">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="flex flex-1 flex-col md:flex-row overflow-y-auto md:overflow-hidden">
          <div className="w-full md:w-64 max-h-44 md:max-h-none border-b md:border-b-0 md:border-r border-hud-bg-elev p-4 overflow-y-auto flex-shrink-0">
            <div className="space-y-1">
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

          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedPipeline ? (
              <>
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="flex items-center justify-between gap-2 mb-4">
                    {editingPipelineName !== null ? (
                      <div className="flex-1 flex items-center gap-2">
                        <input
                          type="text"
                          value={editingPipelineName}
                          onChange={(e) => setEditingPipelineName(e.target.value)}
                          className="flex-1 px-2 py-1 bg-hud-bg-elev border border-hud-cream-mute rounded text-white"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenamePipeline();
                            if (e.key === 'Escape') {
                              setEditingPipelineName(null);
                              setPipelineError('');
                            }
                          }}
                        />
                        <button
                          onClick={handleRenamePipeline}
                          disabled={saving}
                          className="p-1 hover:bg-hud-cream-mute rounded disabled:opacity-50"
                          title="Save name"
                        >
                          <Check className="w-4 h-4 text-hud-emerald" />
                        </button>
                        <button
                          onClick={() => {
                            setEditingPipelineName(null);
                            setPipelineError('');
                          }}
                          className="p-1 hover:bg-hud-cream-mute rounded"
                          title="Cancel"
                        >
                          <X className="w-4 h-4 text-hud-cream-dim" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 min-w-0">
                        <h3 className="text-lg font-medium text-white truncate">{selectedPipeline.name}</h3>
                        {canManagePipelines && (
                          <>
                            <button
                              onClick={() => {
                                setEditingPipelineName(selectedPipeline.name);
                                setPipelineError('');
                              }}
                              className="p-1 hover:bg-hud-cream-mute rounded"
                              title="Rename pipeline"
                            >
                              <Edit2 className="w-4 h-4 text-hud-cream-dim" />
                            </button>
                            <button
                              onClick={() => setShowDeletePipeline(true)}
                              disabled={pipelines.length <= 1}
                              className="p-1 hover:bg-hud-cream-mute rounded disabled:opacity-30 disabled:cursor-not-allowed"
                              title={pipelines.length <= 1 ? "You can't delete the only pipeline" : 'Delete pipeline'}
                            >
                              <Trash2 className="w-4 h-4 text-hud-plum" />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {onPipelineSelect && (
                      <button
                        onClick={() => {
                          onPipelineSelect(selectedPipeline);
                          onClose();
                        }}
                        className="px-3 py-1.5 bg-hud-gold-deep text-white rounded text-sm hover:bg-hud-gold-deep shrink-0"
                      >
                        Select Pipeline
                      </button>
                    )}
                  </div>

                  {editingPipelineName !== null && selectedPipeline.name === 'Government' && (
                    <p className="text-xs text-hud-rust -mt-2 mb-4">
                      SAM.gov imports look for a pipeline named exactly "Government". Renaming it will break those imports.
                    </p>
                  )}

                  {pipelineError && (
                    <div className="p-3 mb-4 bg-hud-plum/20 border border-hud-plum/30 rounded-lg text-hud-plum text-sm">
                      {pipelineError}
                    </div>
                  )}

                  <div className="flex gap-2 mb-4">
                    <button
                      onClick={() => setActiveTab('stages')}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm ${
                        activeTab === 'stages'
                          ? 'bg-hud-gold/20 text-hud-gold-soft'
                          : 'text-hud-cream-dim hover:bg-hud-bg-elev'
                      }`}
                    >
                      <Columns className="w-4 h-4" />
                      Stages
                      <span className="text-xs bg-hud-cream-mute px-1.5 py-0.5 rounded">
                        {currentStages.length}
                      </span>
                    </button>
                    <button
                      onClick={() => setActiveTab('fields')}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm ${
                        activeTab === 'fields'
                          ? 'bg-hud-gold/20 text-hud-gold-soft'
                          : 'text-hud-cream-dim hover:bg-hud-bg-elev'
                      }`}
                    >
                      <Settings className="w-4 h-4" />
                      Custom Fields
                    </button>
                  </div>

                  {activeTab === 'stages' && (
                    <div className="space-y-2">
                      {currentStages.map((stage, index) => (
                        <div key={stage.id} className="bg-hud-bg-elev/50 rounded">
                          <div className="flex items-center gap-2 p-3 group">
                            <GripVertical className="w-4 h-4 text-hud-cream-mute" />
                            {editingStageId === stage.id ? (
                              <div className="flex-1 flex items-center gap-2">
                                <input
                                  type="text"
                                  value={editingStageName}
                                  onChange={(e) => setEditingStageName(e.target.value)}
                                  className="flex-1 px-2 py-1 bg-hud-cream-mute border border-hud-cream-mute rounded text-white text-sm"
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
                                  className="p-1 hover:bg-hud-cream-mute rounded"
                                >
                                  <Check className="w-4 h-4 text-hud-emerald" />
                                </button>
                                <button
                                  onClick={() => {
                                    setEditingStageId(null);
                                    setEditingStageName('');
                                  }}
                                  className="p-1 hover:bg-hud-cream-mute rounded"
                                >
                                  <X className="w-4 h-4 text-hud-cream-dim" />
                                </button>
                              </div>
                            ) : (
                              <>
                                <div className="flex-1">
                                  <span className="text-white">{stage.name}</span>
                                  {stage.aging_threshold_days && (
                                    <span className="ml-2 text-xs text-hud-rust">
                                      <Clock className="w-3 h-3 inline mr-1" />
                                      {stage.aging_threshold_days}d
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 reveal-on-touch">
                                  <button
                                    onClick={() => setExpandedStageId(expandedStageId === stage.id ? null : stage.id)}
                                    className={`p-1 hover:bg-hud-cream-mute rounded ${expandedStageId === stage.id ? 'bg-hud-cream-mute' : ''}`}
                                    title="Stage settings"
                                  >
                                    <Settings className="w-4 h-4 text-hud-cream-dim" />
                                  </button>
                                  <button
                                    onClick={() => handleMoveStage(stage.id, 'up')}
                                    disabled={index === 0}
                                    className="p-1 hover:bg-hud-cream-mute rounded disabled:opacity-30"
                                  >
                                    <ChevronUp className="w-4 h-4 text-hud-cream-dim" />
                                  </button>
                                  <button
                                    onClick={() => handleMoveStage(stage.id, 'down')}
                                    disabled={index === currentStages.length - 1}
                                    className="p-1 hover:bg-hud-cream-mute rounded disabled:opacity-30"
                                  >
                                    <ChevronDown className="w-4 h-4 text-hud-cream-dim" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      setEditingStageId(stage.id);
                                      setEditingStageName(stage.name);
                                    }}
                                    className="p-1 hover:bg-hud-cream-mute rounded"
                                  >
                                    <Edit2 className="w-4 h-4 text-hud-cream-dim" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteStage(stage.id)}
                                    className="p-1 hover:bg-hud-cream-mute rounded"
                                  >
                                    <Trash2 className="w-4 h-4 text-hud-plum" />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                          {expandedStageId === stage.id && (
                            <div className="px-3 pb-3 pt-1 border-t border-hud-cream-mute">
                              <div className="flex items-center gap-3">
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
                                  className="w-24 px-2 py-1 bg-hud-cream-mute border border-hud-cream-mute rounded text-white text-sm"
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
                              <p className="text-xs text-hud-cream-mute mt-1">
                                Opportunities in this stage longer than this will show an aging warning
                              </p>
                            </div>
                          )}
                        </div>
                      ))}

                      <div className="flex items-center gap-2 mt-4">
                        <input
                          type="text"
                          value={newStageName}
                          onChange={(e) => setNewStageName(e.target.value)}
                          placeholder="New stage name"
                          className="flex-1 px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm"
                          onKeyDown={(e) => e.key === 'Enter' && handleCreateStage()}
                        />
                        <button
                          onClick={handleCreateStage}
                          disabled={saving || !newStageName.trim()}
                          className="px-4 py-2 bg-hud-gold-deep text-white rounded hover:bg-hud-gold-deep disabled:opacity-50"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {activeTab === 'fields' && selectedPipeline && (
                    <div className="space-y-3">
                      {(selectedPipeline.custom_fields || []).map(field => (
                        <div
                          key={field.id}
                          className="flex items-center justify-between p-3 bg-hud-bg-elev/50 rounded"
                        >
                          <div>
                            <div className="text-white font-medium">{field.label}</div>
                            <div className="text-sm text-hud-cream-dim">
                              {field.field_type} {field.required && '(required)'}
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteField(field.id)}
                            className="p-1 hover:bg-hud-cream-mute rounded"
                          >
                            <Trash2 className="w-4 h-4 text-hud-plum" />
                          </button>
                        </div>
                      ))}

                      {showNewFieldForm ? (
                        <div className="p-4 bg-hud-bg-elev/50 rounded space-y-3">
                          <div>
                            <label className="block text-sm text-hud-cream-dim mb-1">Label</label>
                            <input
                              type="text"
                              value={newFieldForm.label}
                              onChange={(e) => setNewFieldForm({ ...newFieldForm, label: e.target.value })}
                              className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-hud-cream-dim mb-1">Type</label>
                            <select
                              value={newFieldForm.field_type}
                              onChange={(e) => setNewFieldForm({
                                ...newFieldForm,
                                field_type: e.target.value as PipelineCustomField['field_type']
                              })}
                              className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white"
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
                              <label className="block text-sm text-hud-cream-dim mb-1">Options</label>
                              <div className="space-y-2">
                                {newFieldForm.options.map((opt, i) => (
                                  <div key={i} className="flex items-center gap-2">
                                    <span className="flex-1 px-3 py-1.5 bg-hud-cream-mute rounded text-sm text-white">{opt}</span>
                                    <button
                                      onClick={() => removeOption(i)}
                                      className="p-1 hover:bg-hud-cream-mute rounded"
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
                                    className="flex-1 px-3 py-1.5 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm"
                                    onKeyDown={(e) => e.key === 'Enter' && addOption()}
                                  />
                                  <button
                                    onClick={addOption}
                                    className="px-3 py-1.5 bg-hud-cream-mute text-white rounded text-sm"
                                  >
                                    Add
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-sm text-hud-cream-soft">
                              <input
                                type="checkbox"
                                checked={newFieldForm.required}
                                onChange={(e) => setNewFieldForm({ ...newFieldForm, required: e.target.checked })}
                                className="rounded bg-hud-bg-elev border-hud-cream-mute"
                              />
                              Required
                            </label>
                            <label className="flex items-center gap-2 text-sm text-hud-cream-soft">
                              <input
                                type="checkbox"
                                checked={newFieldForm.filterable}
                                onChange={(e) => setNewFieldForm({ ...newFieldForm, filterable: e.target.checked })}
                                className="rounded bg-hud-bg-elev border-hud-cream-mute"
                              />
                              Filterable
                            </label>
                          </div>

                          <div className="flex gap-2">
                            <button
                              onClick={handleCreateField}
                              disabled={saving || !newFieldForm.label.trim()}
                              className="flex-1 px-4 py-2 bg-hud-gold-deep text-white rounded hover:bg-hud-gold-deep disabled:opacity-50"
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
                              className="px-4 py-2 bg-hud-cream-mute text-white rounded hover:bg-hud-cream-mute"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowNewFieldForm(true)}
                          className="flex items-center gap-2 px-4 py-2 bg-hud-bg-elev text-hud-cream-soft rounded hover:bg-hud-cream-mute"
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
                <p>No pipeline selected</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {showDeletePipeline && selectedPipeline && (
        <DeletePipelineModal
          pipeline={selectedPipeline}
          pipelines={pipelines}
          onClose={() => setShowDeletePipeline(false)}
          onDeleted={handlePipelineDeleted}
        />
      )}
    </div></Portal>
  );
}
