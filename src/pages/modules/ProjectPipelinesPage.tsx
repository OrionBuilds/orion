import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, GripVertical, Trash2, CreditCard as Edit2, Check, X, Clock, Layers, AlertCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import type { ProjectPipeline, ProjectPipelineOwner, ProjectStage } from '../../types';
import * as pipelineService from '../../services/projectPipelines';

const STAGE_COLORS = ['#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#f97316', '#64748b'];

const OWNER_OPTIONS: { value: ProjectPipelineOwner; label: string }[] = [
  { value: 'friday', label: 'FRIDAY (friday)' },
  { value: 'clara', label: 'CLARA (clara)' },
];

const OWNER_BADGE_CLASS: Record<ProjectPipelineOwner, string> = {
  friday: 'bg-hud-gold/15 text-hud-gold-soft border-hud-gold/40',
  clara: 'bg-hud-plum/15 text-hud-plum border-hud-plum/40',
};
// A persisted owner the UI no longer offers (a retired agent) still renders, in a neutral style.
const UNKNOWN_OWNER_CLASS = 'bg-hud-bg-elev text-hud-cream-dim border-hud-line-soft';

// RLS only lets SuperAdmin/Admin (hierarchy_level <= 2) write pipelines and stages.
const ADMIN_HIERARCHY_MAX = 2;

function OwnerBadge({ owner, className = '' }: { owner: ProjectPipelineOwner | null; className?: string }) {
  if (!owner) return null;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold tracking-wide ${OWNER_BADGE_CLASS[owner] ?? UNKNOWN_OWNER_CLASS} ${className}`}
    >
      {owner.toUpperCase()}
    </span>
  );
}

// Map Postgres constraint errors to copy the user can act on.
function describeError(err: unknown, fallback: string): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === '23505') return 'That agent already owns another pipeline.';
  if (code === '23503') return 'This pipeline still has projects. Move or archive its projects first.';
  const message = (err as { message?: string } | null)?.message;
  return message ? `${fallback}: ${message}` : fallback;
}

export function ProjectPipelinesPage() {
  const { user } = useAuth();
  const hasManagePermission = usePermission('project_pipelines.manage');
  // Write controls require the permission AND an Admin/SuperAdmin role, mirroring the
  // RLS policy on project_pipelines / project_stages (hierarchy_level <= 2).
  const canManage = hasManagePermission && (user?.role?.hierarchy_level ?? Number.MAX_SAFE_INTEGER) <= ADMIN_HIERARCHY_MAX;

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('pipeline');

  const [pipelines, setPipelines] = useState<ProjectPipeline[]>([]);
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // New pipeline form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [newPipelineOwner, setNewPipelineOwner] = useState<ProjectPipelineOwner | ''>('');
  const [copyStagesFromId, setCopyStagesFromId] = useState('');
  const [creating, setCreating] = useState(false);

  // Selected pipeline header
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingPipeline, setSavingPipeline] = useState(false);

  // Stage editor (scoped to the selected pipeline)
  const [newStageName, setNewStageName] = useState('');
  const [newStageSla, setNewStageSla] = useState(0);
  const [newStageColor, setNewStageColor] = useState(STAGE_COLORS[0]);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [editStageName, setEditStageName] = useState('');
  const [editStageSla, setEditStageSla] = useState(0);
  const [draggedStageId, setDraggedStageId] = useState<string | null>(null);

  const pipeline = pipelines.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    loadPipelines();
  }, [user]);

  // Default to the first pipeline, and fall back if the URL points at a missing one.
  useEffect(() => {
    if (loading || pipelines.length === 0) return;
    if (!selectedId || !pipelines.some((p) => p.id === selectedId)) {
      selectPipeline(pipelines[0].id, true);
    }
  }, [loading, pipelines, selectedId]);

  // Reset per-pipeline editing state when the selection changes.
  useEffect(() => {
    setEditingName(false);
    setEditingStageId(null);
    setDraggedStageId(null);
    setErrorMessage(null);
  }, [selectedId]);

  function selectPipeline(id: string, replace = false) {
    const next = new URLSearchParams(searchParams);
    next.set('pipeline', id);
    setSearchParams(next, { replace });
  }

  async function loadPipelines() {
    if (!user) return;
    try {
      const data = await pipelineService.getProjectPipelines(user.organization_id);
      setPipelines(data);
      await loadCounts(data.map((p) => p.id));
    } catch (err) {
      console.error('Failed to load pipelines:', err);
      setErrorMessage(describeError(err, 'Failed to load pipelines'));
    } finally {
      setLoading(false);
    }
  }

  async function loadCounts(ids: string[]) {
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await pipelineService.countProjectsInPipeline(id)] as const;
        } catch (err) {
          console.error('Failed to count projects:', err);
          return [id, 0] as const;
        }
      })
    );
    setProjectCounts(Object.fromEntries(entries));
  }

  function updateSelectedPipeline(updater: (prev: ProjectPipeline) => ProjectPipeline) {
    setPipelines((prev) => prev.map((p) => (p.id === selectedId ? updater(p) : p)));
  }

  // ---- Pipeline CRUD ----

  async function handleCreatePipeline() {
    if (!user || !newPipelineName.trim()) return;
    setCreating(true);
    setErrorMessage(null);
    try {
      const created = await pipelineService.createProjectPipelineWithStages(
        user.organization_id,
        newPipelineName.trim(),
        [],
        null,
        newPipelineOwner || null,
        copyStagesFromId || null
      );
      setPipelines((prev) => [...prev, created]);
      setProjectCounts((prev) => ({ ...prev, [created.id]: 0 }));
      setNewPipelineName('');
      setNewPipelineOwner('');
      setCopyStagesFromId('');
      setShowNewForm(false);
      selectPipeline(created.id);
    } catch (err) {
      console.error('Failed to create pipeline:', err);
      setErrorMessage(describeError(err, 'Failed to create pipeline'));
    } finally {
      setCreating(false);
    }
  }

  async function handleRenamePipeline() {
    if (!pipeline || !nameDraft.trim()) return;
    if (nameDraft.trim() === pipeline.name) {
      setEditingName(false);
      return;
    }
    setSavingPipeline(true);
    setErrorMessage(null);
    try {
      const updated = await pipelineService.updateProjectPipeline(pipeline.id, { name: nameDraft.trim() });
      updateSelectedPipeline((prev) => ({ ...prev, name: updated.name }));
      setEditingName(false);
    } catch (err) {
      console.error('Failed to rename pipeline:', err);
      setErrorMessage(describeError(err, 'Failed to rename pipeline'));
    } finally {
      setSavingPipeline(false);
    }
  }

  async function handleChangeOwner(owner: ProjectPipelineOwner | null) {
    if (!pipeline || owner === pipeline.owner_agent) return;
    setSavingPipeline(true);
    setErrorMessage(null);
    try {
      const updated = await pipelineService.updateProjectPipeline(pipeline.id, { owner_agent: owner });
      updateSelectedPipeline((prev) => ({ ...prev, owner_agent: updated.owner_agent }));
    } catch (err) {
      console.error('Failed to update pipeline owner:', err);
      setErrorMessage(describeError(err, 'Failed to update pipeline owner'));
    } finally {
      setSavingPipeline(false);
    }
  }

  async function handleDeletePipeline() {
    if (!pipeline) return;
    if ((projectCounts[pipeline.id] ?? 0) > 0) return;
    if (!confirm(`Delete the "${pipeline.name}" pipeline and all of its stages?`)) return;
    setSavingPipeline(true);
    setErrorMessage(null);
    try {
      await pipelineService.deleteProjectPipeline(pipeline.id);
      const remaining = pipelines.filter((p) => p.id !== pipeline.id);
      setPipelines(remaining);
      setProjectCounts((prev) => {
        const next = { ...prev };
        delete next[pipeline.id];
        return next;
      });
      if (remaining.length > 0) {
        selectPipeline(remaining[0].id, true);
      } else {
        const next = new URLSearchParams(searchParams);
        next.delete('pipeline');
        setSearchParams(next, { replace: true });
      }
    } catch (err) {
      console.error('Failed to delete pipeline:', err);
      setErrorMessage(describeError(err, 'Failed to delete pipeline'));
      // The RESTRICT constraint fired — refresh the count so the button reflects reality.
      loadCounts([pipeline.id]).then(() => undefined);
    } finally {
      setSavingPipeline(false);
    }
  }

  // ---- Stage editor (unchanged behaviour, scoped to the selected pipeline) ----

  async function handleAddStage() {
    if (!user || !pipeline || !newStageName.trim()) return;
    try {
      const stage = await pipelineService.createProjectStage(
        user.organization_id,
        pipeline.id,
        newStageName.trim(),
        newStageSla,
        newStageColor
      );
      updateSelectedPipeline((prev) => ({ ...prev, stages: [...(prev.stages || []), stage] }));
      setNewStageName('');
      setNewStageSla(0);
      setNewStageColor(STAGE_COLORS[0]);
    } catch (err) {
      console.error('Failed to add stage:', err);
      setErrorMessage(describeError(err, 'Failed to add stage'));
    }
  }

  async function handleUpdateStage(stageId: string) {
    if (!editStageName.trim()) return;
    try {
      const updated = await pipelineService.updateProjectStage(stageId, {
        name: editStageName.trim(),
        sla_days: editStageSla,
      });
      updateSelectedPipeline((prev) => ({
        ...prev,
        stages: (prev.stages || []).map((s) => (s.id === stageId ? updated : s)),
      }));
      setEditingStageId(null);
    } catch (err) {
      console.error('Failed to update stage:', err);
      setErrorMessage(describeError(err, 'Failed to update stage'));
    }
  }

  async function handleDeleteStage(stageId: string) {
    if (!confirm('Delete this stage?')) return;
    try {
      await pipelineService.deleteProjectStage(stageId);
      updateSelectedPipeline((prev) => ({
        ...prev,
        stages: (prev.stages || []).filter((s) => s.id !== stageId),
      }));
    } catch (err) {
      console.error('Failed to delete stage:', err);
      setErrorMessage(describeError(err, 'Failed to delete stage'));
    }
  }

  function handleDragStart(stageId: string) {
    setDraggedStageId(stageId);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  async function handleDrop(targetStageId: string) {
    if (!pipeline || !draggedStageId || draggedStageId === targetStageId) return;

    const stages = [...(pipeline.stages || [])];
    const dragIdx = stages.findIndex((s) => s.id === draggedStageId);
    const dropIdx = stages.findIndex((s) => s.id === targetStageId);
    if (dragIdx < 0 || dropIdx < 0) return;

    const [moved] = stages.splice(dragIdx, 1);
    stages.splice(dropIdx, 0, moved);

    updateSelectedPipeline((prev) => ({ ...prev, stages }));

    try {
      await pipelineService.reorderProjectStages(pipeline.id, stages.map((s) => s.id));
    } catch (err) {
      console.error('Failed to reorder:', err);
      loadPipelines();
    }
    setDraggedStageId(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  const stages: ProjectStage[] = pipeline?.stages || [];
  const selectedCount = pipeline ? projectCounts[pipeline.id] ?? 0 : 0;
  const deleteBlocked = selectedCount > 0;

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Project Pipelines</h2>
          <p className="text-sm text-hud-cream-dim mt-1">
            Engineering and SEO are managed by FRIDAY. Agents can only create and move projects
            inside the pipeline they own.
          </p>
        </div>

        {errorMessage && (
          <div className="flex items-start gap-2 px-4 py-3 bg-hud-plum/10 border border-hud-plum/40 rounded-lg text-sm text-hud-plum">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="flex-1">{errorMessage}</span>
            <button onClick={() => setErrorMessage(null)} className="p-0.5 hover:bg-hud-bg-elev rounded">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-6">
          {/* Left rail: pipeline list */}
          <aside className="md:w-64 flex-shrink-0 space-y-3">
            <div className="bg-hud-bg-card border border-hud-bg-elev rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-hud-bg-elev">
                <span className="text-xs font-semibold uppercase tracking-wide text-hud-cream-dim">Pipelines</span>
                {canManage && (
                  <button
                    onClick={() => setShowNewForm((v) => !v)}
                    className="flex items-center gap-1 text-xs text-hud-gold-soft hover:text-white transition-colors"
                    title="New pipeline"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New
                  </button>
                )}
              </div>

              {pipelines.length === 0 ? (
                <p className="px-4 py-6 text-sm text-hud-cream-dim text-center">No pipelines yet.</p>
              ) : (
                <ul className="py-1">
                  {pipelines.map((p) => {
                    const active = p.id === selectedId;
                    return (
                      <li key={p.id}>
                        <button
                          onClick={() => selectPipeline(p.id)}
                          className={`w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
                            active
                              ? 'bg-hud-bg-elev text-white'
                              : 'text-hud-cream-soft hover:bg-hud-bg-mid/60 hover:text-white'
                          }`}
                        >
                          <span className="flex-1 truncate">{p.name}</span>
                          <OwnerBadge owner={p.owner_agent} />
                          <span
                            className="text-xs text-hud-cream-mute tabular-nums"
                            title={`${projectCounts[p.id] ?? 0} project${(projectCounts[p.id] ?? 0) === 1 ? '' : 's'}`}
                          >
                            {projectCounts[p.id] ?? 0}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {canManage && showNewForm && (
              <div className="bg-hud-bg-card border border-hud-bg-elev rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-medium text-white">New pipeline</h4>
                <input
                  type="text"
                  value={newPipelineName}
                  onChange={(e) => setNewPipelineName(e.target.value)}
                  placeholder="Pipeline name"
                  className="w-full bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreatePipeline()}
                  autoFocus
                />
                <label className="block">
                  <span className="text-xs text-hud-cream-dim">Owner (optional)</span>
                  <select
                    value={newPipelineOwner}
                    onChange={(e) => setNewPipelineOwner(e.target.value as ProjectPipelineOwner | '')}
                    className="mt-1 w-full bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  >
                    <option value="">None</option>
                    {OWNER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-hud-cream-dim">Copy stages from (optional)</span>
                  <select
                    value={copyStagesFromId}
                    onChange={(e) => setCopyStagesFromId(e.target.value)}
                    className="mt-1 w-full bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  >
                    <option value="">Start empty</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({(p.stages || []).length} stage{(p.stages || []).length === 1 ? '' : 's'})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={() => {
                      setShowNewForm(false);
                      setNewPipelineName('');
                      setNewPipelineOwner('');
                      setCopyStagesFromId('');
                    }}
                    className="px-3 py-1.5 text-sm text-hud-cream-dim hover:text-white rounded-lg hover:bg-hud-bg-elev transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreatePipeline}
                    disabled={creating || !newPipelineName.trim()}
                    className="px-3 py-1.5 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep text-sm disabled:opacity-50 transition-colors"
                  >
                    {creating ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </div>
            )}
          </aside>

          {/* Main: selected pipeline */}
          <div className="flex-1 min-w-0">
            {!pipeline ? (
              <div className="text-center py-16">
                <div className="w-16 h-16 bg-hud-bg-elev/50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Layers className="w-8 h-8 text-hud-cream-mute" />
                </div>
                <h3 className="text-lg font-medium text-white mb-2">No pipeline configured</h3>
                <p className="text-hud-cream-dim text-sm">
                  {canManage
                    ? 'Create a pipeline to define the stages projects move through.'
                    : 'Contact your administrator to set up the project pipelines.'}
                </p>
              </div>
            ) : (
              <div className="bg-hud-bg-card border border-hud-bg-elev rounded-xl overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-hud-bg-elev">
                  <div className="min-w-0 flex-1">
                    {editingName ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          className="flex-1 bg-hud-bg-mid border border-hud-cream-mute rounded px-2 py-1 text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenamePipeline();
                            if (e.key === 'Escape') setEditingName(false);
                          }}
                          autoFocus
                        />
                        <button
                          onClick={handleRenamePipeline}
                          disabled={savingPipeline || !nameDraft.trim()}
                          className="p-1 text-hud-emerald hover:bg-hud-bg-elev rounded disabled:opacity-50"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingName(false)}
                          className="p-1 text-hud-cream-dim hover:bg-hud-bg-elev rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 group/name">
                        <h3 className="text-white font-medium truncate">{pipeline.name}</h3>
                        <OwnerBadge owner={pipeline.owner_agent} />
                        {canManage && (
                          <button
                            onClick={() => {
                              setNameDraft(pipeline.name);
                              setEditingName(true);
                            }}
                            className="p-1 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded opacity-0 group-hover/name:opacity-100 reveal-on-touch transition-opacity"
                            title="Rename pipeline"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                    <p className="text-xs text-hud-cream-dim mt-0.5">
                      {stages.length} stage{stages.length !== 1 ? 's' : ''} · {selectedCount} project
                      {selectedCount !== 1 ? 's' : ''}
                    </p>
                  </div>

                  {canManage && (
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 text-xs text-hud-cream-dim">
                        Owner
                        <select
                          value={pipeline.owner_agent ?? ''}
                          onChange={(e) => handleChangeOwner((e.target.value || null) as ProjectPipelineOwner | null)}
                          disabled={savingPipeline}
                          className="bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold disabled:opacity-50"
                        >
                          <option value="">None</option>
                          {OWNER_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                          {pipeline.owner_agent && !OWNER_OPTIONS.some((o) => o.value === pipeline.owner_agent) && (
                            // A persisted owner that is no longer an active agent: shown so the value
                            // renders truthfully, never offered as a choice.
                            <option value={pipeline.owner_agent} disabled>{String(pipeline.owner_agent).toUpperCase()} (retired)</option>
                          )}
                        </select>
                      </label>
                      <span
                        title={
                          deleteBlocked
                            ? `This pipeline has ${selectedCount} project${selectedCount === 1 ? '' : 's'}. Move or archive its projects first.`
                            : 'Delete pipeline'
                        }
                      >
                        <button
                          onClick={handleDeletePipeline}
                          disabled={deleteBlocked || savingPipeline}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-hud-cream-dim hover:text-hud-plum hover:bg-hud-bg-elev rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-hud-cream-dim disabled:hover:bg-transparent"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </button>
                      </span>
                    </div>
                  )}
                </div>

                <div className="p-5 space-y-2">
                  {stages.map((stage) => (
                    <div
                      key={stage.id}
                      draggable={canManage}
                      onDragStart={() => handleDragStart(stage.id)}
                      onDragOver={handleDragOver}
                      onDrop={() => handleDrop(stage.id)}
                      className={`flex items-center gap-3 px-3 py-2.5 bg-hud-bg-mid/50 rounded-lg border border-hud-bg-elev/50 group ${
                        draggedStageId === stage.id ? 'opacity-50' : ''
                      }`}
                    >
                      {canManage && (
                        <GripVertical className="w-4 h-4 text-hud-cream-mute cursor-grab flex-shrink-0" />
                      )}
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: stage.color || '#64748b' }}
                      />
                      {editingStageId === stage.id ? (
                        <div className="flex-1 flex items-center gap-2">
                          <input
                            type="text"
                            value={editStageName}
                            onChange={(e) => setEditStageName(e.target.value)}
                            className="flex-1 bg-hud-bg-card border border-hud-cream-mute rounded px-2 py-1 text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                            onKeyDown={(e) => e.key === 'Enter' && handleUpdateStage(stage.id)}
                            autoFocus
                          />
                          <div className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-hud-cream-mute" />
                            <input
                              type="number"
                              value={editStageSla}
                              onChange={(e) => setEditStageSla(Number(e.target.value))}
                              className="w-16 bg-hud-bg-card border border-hud-cream-mute rounded px-2 py-1 text-white text-sm"
                              min={0}
                            />
                            <span className="text-xs text-hud-cream-mute">days</span>
                          </div>
                          <button
                            onClick={() => handleUpdateStage(stage.id)}
                            className="p-1 text-hud-emerald hover:bg-hud-bg-elev rounded"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setEditingStageId(null)}
                            className="p-1 text-hud-cream-dim hover:bg-hud-bg-elev rounded"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <span className="flex-1 text-sm text-white">{stage.name}</span>
                          {stage.sla_days > 0 && (
                            <span className="flex items-center gap-1 text-xs text-hud-cream-mute">
                              <Clock className="w-3 h-3" />
                              {stage.sla_days}d SLA
                            </span>
                          )}
                          {canManage && (
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity">
                              <button
                                onClick={() => {
                                  setEditingStageId(stage.id);
                                  setEditStageName(stage.name);
                                  setEditStageSla(stage.sla_days);
                                }}
                                className="p-1 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteStage(stage.id)}
                                className="p-1 text-hud-cream-dim hover:text-hud-plum hover:bg-hud-bg-elev rounded"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}

                  {stages.length === 0 && (
                    <p className="text-sm text-hud-cream-dim text-center py-4">
                      No stages yet{canManage ? ' — add the first one below.' : '.'}
                    </p>
                  )}

                  {canManage && (
                    <div className="flex items-center gap-2 pt-3 border-t border-hud-bg-elev/50 mt-3">
                      <input
                        type="text"
                        value={newStageName}
                        onChange={(e) => setNewStageName(e.target.value)}
                        placeholder="New stage name"
                        className="flex-1 bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                        onKeyDown={(e) => e.key === 'Enter' && handleAddStage()}
                      />
                      <div className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-hud-cream-mute" />
                        <input
                          type="number"
                          value={newStageSla}
                          onChange={(e) => setNewStageSla(Number(e.target.value))}
                          className="w-16 bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-2 py-2 text-white text-sm"
                          placeholder="SLA"
                          min={0}
                        />
                      </div>
                      <div className="flex gap-1">
                        {STAGE_COLORS.slice(0, 4).map((c) => (
                          <button
                            key={c}
                            onClick={() => setNewStageColor(c)}
                            className={`w-6 h-6 rounded-full border-2 transition-colors ${
                              newStageColor === c ? 'border-white' : 'border-transparent'
                            }`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <button
                        onClick={handleAddStage}
                        disabled={!newStageName.trim()}
                        className="px-3 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep text-sm disabled:opacity-50 transition-colors"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
