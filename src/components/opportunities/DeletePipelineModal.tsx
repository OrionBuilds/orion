import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import type { Pipeline } from '../../types';
import * as pipelinesService from '../../services/pipelines';
import * as opportunitiesService from '../../services/opportunities';
import { Portal } from '../shared/Portal';

// Must match CLARA_LEAD_PIPELINE_ID used by supabase/functions/clara-web-responder and scorecard-submit
// (set it here as VITE_LEAD_PIPELINE_ID). Website leads land in this pipeline by ID.
const WEBSITE_LEAD_PIPELINE_ID: string = import.meta.env.VITE_LEAD_PIPELINE_ID || '';
// supabase/functions/sam-gov-api looks the pipeline up by this exact name.
const SAM_GOV_PIPELINE_NAME = 'Government';

interface DeletePipelineModalProps {
  pipeline: Pipeline;
  // All pipelines in display (sort_order) order, with stages.
  pipelines: Pipeline[];
  onClose: () => void;
  onDeleted: (pipelineId: string) => void;
}

function describeDeleteError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === '23503') {
    return 'New opportunities were added to this pipeline while it was being deleted. Try again.';
  }
  const message = (err as { message?: string } | null)?.message;
  return message ? `Failed to delete pipeline: ${message}` : 'Failed to delete pipeline';
}

export function DeletePipelineModal({ pipeline, pipelines, onClose, onDeleted }: DeletePipelineModalProps) {
  const { user } = useAuth();
  const otherPipelines = pipelines.filter(p => p.id !== pipeline.id);
  const firstTarget = otherPipelines.find(p => (p.stages?.length ?? 0) > 0);

  const [loading, setLoading] = useState(true);
  const [opportunityCount, setOpportunityCount] = useState(0);
  const [usage, setUsage] = useState<pipelinesService.PipelineUsage | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [targetPipelineId, setTargetPipelineId] = useState(firstTarget?.id ?? '');
  const [targetStageId, setTargetStageId] = useState(firstTarget?.stages?.[0]?.id ?? '');
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');

  const stageIds = (pipeline.stages || []).map(s => s.id);
  const customFieldCount = pipeline.custom_fields?.length ?? 0;
  const targetPipeline = otherPipelines.find(p => p.id === targetPipelineId);
  const isOnlyPipeline = otherPipelines.length === 0;
  const isDefault = pipelines[0]?.id === pipeline.id;
  const needsTarget = opportunityCount > 0;
  const canDelete =
    !loading && !deleting && !isOnlyPipeline && (!needsTarget || (!!targetPipelineId && !!targetStageId));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const count = await pipelinesService.countPipelineOpportunities(pipeline.id);
        if (!cancelled) setOpportunityCount(count);
      } catch (err) {
        if (!cancelled) setError(describeDeleteError(err));
      }
      try {
        const result = await pipelinesService.getPipelineUsage(pipeline.org_id, pipeline.id);
        if (!cancelled) setUsage(result);
      } catch (err) {
        console.error('Failed to check pipeline usage:', err);
        if (!cancelled) setUsageFailed(true);
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
    // Re-run only when the pipeline changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.id]);

  function handleTargetPipelineChange(pipelineId: string) {
    setTargetPipelineId(pipelineId);
    const next = otherPipelines.find(p => p.id === pipelineId);
    setTargetStageId(next?.stages?.[0]?.id ?? '');
  }

  async function handleDelete() {
    if (!user || !canDelete) return;
    setError('');
    setDeleting(true);
    try {
      // Re-read at delete time: opportunities can arrive (forms, automations) after the count.
      const ids = await pipelinesService.getPipelineOpportunityIds(pipeline.id);
      if (ids.length > 0) {
        if (!targetPipelineId || !targetStageId) {
          setOpportunityCount(ids.length);
          setError(`This pipeline now has ${ids.length} opportunit${ids.length === 1 ? 'y' : 'ies'}. Choose where to move them, then delete again.`);
          return;
        }
        setProgress({ done: 0, total: ids.length });
        await opportunitiesService.moveOpportunitiesToPipeline(
          ids,
          targetPipelineId,
          targetStageId,
          user.id,
          (done, total) => setProgress({ done, total })
        );
      }
      await pipelinesService.deletePipeline(pipeline.id);
      onDeleted(pipeline.id);
    } catch (err) {
      console.error('Failed to delete pipeline:', err);
      setError(describeDeleteError(err));
      // Some opportunities may have moved before the failure; show the real remainder.
      pipelinesService.countPipelineOpportunities(pipeline.id).then(setOpportunityCount).catch(() => {});
    } finally {
      setDeleting(false);
      setProgress(null);
    }
  }

  const integrationWarnings: string[] = [];
  if (pipeline.id === WEBSITE_LEAD_PIPELINE_ID) {
    integrationWarnings.push(
      'Website leads (Clara chat and the readiness scorecard) are sent to this pipeline by ID. They will stop creating opportunities until CLARA_LEAD_PIPELINE_ID points at another pipeline.'
    );
  }
  if (pipeline.name === SAM_GOV_PIPELINE_NAME) {
    integrationWarnings.push(
      `SAM.gov imports look for a pipeline named exactly "${SAM_GOV_PIPELINE_NAME}". Imports will fail until another pipeline has that name.`
    );
  }

  return (
    <Portal><div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-lg max-h-[90dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-hud-plum/20 rounded-lg flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-hud-plum" />
            </div>
            <h2 className="text-lg font-semibold text-white">Delete Pipeline</h2>
          </div>
          <button
            onClick={onClose}
            disabled={deleting}
            className="p-1 text-hud-cream-dim hover:text-white rounded disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3 bg-hud-plum/20 border border-hud-plum/30 rounded-lg text-hud-plum text-sm">
              {error}
            </div>
          )}

          <p className="text-hud-cream-soft">
            Delete the pipeline{' '}
            <span className="text-white font-semibold">"{pipeline.name}"</span>?
          </p>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-hud-cream-dim">
              <div className="w-4 h-4 border-2 border-hud-gold-soft border-t-transparent rounded-full animate-spin" />
              Checking opportunities and usage...
            </div>
          ) : isOnlyPipeline ? (
            <div className="p-3 bg-hud-rust/10 rounded-lg border border-hud-rust/20 text-sm text-hud-rust">
              This is the only pipeline. Create another pipeline before deleting this one.
            </div>
          ) : (
            <>
              {needsTarget && (
                <div className="p-3 bg-hud-bg-card rounded-lg border border-hud-bg-elev space-y-3">
                  <p className="text-sm text-hud-cream-soft">
                    This pipeline has <strong className="text-white">{opportunityCount}</strong>{' '}
                    opportunit{opportunityCount === 1 ? 'y' : 'ies'} (open, won and lost). Move them to:
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-hud-cream-dim mb-1">Pipeline</label>
                      <select
                        value={targetPipelineId}
                        onChange={(e) => handleTargetPipelineChange(e.target.value)}
                        disabled={deleting}
                        className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm"
                      >
                        <option value="">Select pipeline</option>
                        {otherPipelines.map(p => (
                          <option key={p.id} value={p.id} disabled={(p.stages?.length ?? 0) === 0}>
                            {p.name}{(p.stages?.length ?? 0) === 0 ? ' (no stages)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-hud-cream-dim mb-1">Stage</label>
                      <select
                        value={targetStageId}
                        onChange={(e) => setTargetStageId(e.target.value)}
                        disabled={deleting || !targetPipeline}
                        className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm"
                      >
                        <option value="">Select stage</option>
                        {(targetPipeline?.stages || []).map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="text-xs text-hud-cream-mute">
                    Each move is logged on the opportunity's timeline and fires "stage changed" automations and webhooks.
                  </p>
                </div>
              )}

              {isDefault && otherPipelines[0] && (
                <div className="p-3 bg-hud-rust/10 rounded-lg border border-hud-rust/20 text-sm text-hud-rust">
                  This is the first pipeline, used by default for new opportunities and for opportunities created from proposals.
                  "{otherPipelines[0].name}" will become the default.
                </div>
              )}

              {integrationWarnings.map(warning => (
                <div key={warning} className="p-3 bg-hud-rust/10 rounded-lg border border-hud-rust/20 text-sm text-hud-rust">
                  {warning}
                </div>
              ))}

              {usage && usage.forms.length > 0 && (
                <div className="p-3 bg-hud-rust/10 rounded-lg border border-hud-rust/20 text-sm text-hud-rust space-y-1">
                  <p>Still pointing at this pipeline (update them after deleting, or they will fail):</p>
                  <ul className="list-disc pl-5">
                    {usage.forms.map(f => (
                      <li key={f.id}>Form: {f.name}</li>
                    ))}
                  </ul>
                </div>
              )}
              {usageFailed && (
                <p className="text-xs text-hud-cream-mute">
                  Couldn't check forms for references to this pipeline.
                </p>
              )}

              <p className="text-hud-cream-dim text-sm">
                Its {stageIds.length} stage{stageIds.length === 1 ? '' : 's'}
                {customFieldCount > 0 && `, ${customFieldCount} custom field${customFieldCount === 1 ? '' : 's'} (and their values on moved opportunities)`}
                {' '}and the stage-history entries for its stages are deleted with it. This action cannot be undone.
              </p>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={deleting}
            className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors disabled:opacity-50"
          >
            No, Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={!canDelete}
            className="px-4 py-2 bg-hud-plum text-white rounded-lg font-medium hover:bg-hud-plum transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {deleting && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            {deleting
              ? progress
                ? `Moving ${progress.done}/${progress.total}...`
                : 'Deleting...'
              : needsTarget
                ? 'Move & Delete'
                : 'Yes, Delete'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
