import { useState, useEffect, useMemo } from 'react';
import { X, Loader2, Trash2, CalendarClock, Sparkles, SlidersHorizontal } from 'lucide-react';
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  computeNextRunAt,
  type AgentTaskSchedule,
  type AgentSlug,
  type Cadence,
  type RiskTier,
  type OutputKind,
  type ScheduleMode,
} from '../../services/agentTasks';
import { Portal } from '../shared/Portal';
import { TaskBuilder } from './TaskBuilder';
import { inputCls, labelCls } from './shared';

/**
 * Create/edit modal for agent_task_schedules. New schedules open in the conversational builder
 * (TaskBuilder: pick an agent, describe the task, answer questions, confirm); the raw form below
 * stays reachable as "Advanced" and is the only view for editing an existing schedule.
 *
 * Raw form: cadence math is previewed live through the
 * canonical agent_task_next_run_at() SQL function (same one the claim RPC uses), so what
 * the owner sees here is exactly when the agent will fire. The approval-required checkbox
 * is force-checked for client_visible schedules, mirroring the DB CHECK constraint
 * client_visible_requires_approval (client output is never auto-sent).
 */

interface ScheduleEditorModalProps {
  /** Existing schedule to edit; omit/null to create a new one. */
  schedule?: AgentTaskSchedule | null;
  /** Full catalog — used for task_key suggestions and to resolve agent_user_id per slug. */
  schedules: AgentTaskSchedule[];
  orgId: string;
  currentUserId: string;
  onClose: () => void;
  onSaved: (schedule: AgentTaskSchedule) => void;
  onDeleted?: (id: string) => void;
}

const AGENT_OPTIONS: { slug: AgentSlug; label: string }[] = [
  { slug: 'friday', label: 'FRIDAY — engineering' },
  { slug: 'clara', label: 'CLARA — personal/owner' },
];

const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const RISK_OPTIONS: { value: RiskTier; label: string }[] = [
  { value: 'autonomous', label: 'Autonomous — runs and reports' },
  { value: 'owner_review', label: 'Owner review — output gated on you' },
  { value: 'client_visible', label: 'Client visible — always approval-gated' },
];

const OUTPUT_OPTIONS: { value: OutputKind; label: string }[] = [
  { value: 'owner_briefing', label: 'Owner briefing' },
  { value: 'client_deliverable', label: 'Client deliverable' },
  { value: 'housekeeping_report', label: 'Housekeeping report' },
  { value: 'none', label: 'None' },
];

const MODE_OPTIONS: ScheduleMode[] = ['off', 'shadow', 'active'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ScheduleEditorModal({
  schedule,
  schedules,
  orgId,
  currentUserId,
  onClose,
  onSaved,
  onDeleted,
}: ScheduleEditorModalProps) {
  const isEdit = !!schedule;
  const [view, setView] = useState<'builder' | 'advanced'>(isEdit ? 'advanced' : 'builder');

  const [agentSlug, setAgentSlug] = useState<AgentSlug>(schedule?.agent_slug ?? 'friday');
  const [taskKey, setTaskKey] = useState(schedule?.task_key ?? '');
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [description, setDescription] = useState(schedule?.description ?? '');
  const [cadence, setCadence] = useState<Cadence>(
    schedule && schedule.cadence !== 'custom_cron' ? schedule.cadence : 'daily',
  );
  const [timeOfDay, setTimeOfDay] = useState(schedule?.time_of_day ?? '09:00');
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(schedule?.days_of_week ?? [1]);
  const [dayOfMonth, setDayOfMonth] = useState<number>(schedule?.day_of_month ?? 1);
  const [riskTier, setRiskTier] = useState<RiskTier>(schedule?.risk_tier ?? 'autonomous');
  const [outputKind, setOutputKind] = useState<OutputKind>(schedule?.output_kind ?? 'owner_briefing');
  const [approvalRequired, setApprovalRequired] = useState(schedule?.approval_required ?? false);
  const [mode, setMode] = useState<ScheduleMode>(schedule?.mode ?? 'off');
  const [configText, setConfigText] = useState(JSON.stringify(schedule?.config ?? {}, null, 2));

  const [nextRunPreview, setNextRunPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timezone = schedule?.timezone ?? 'America/New_York';
  const clientVisible = riskTier === 'client_visible';
  const effectiveApproval = clientVisible ? true : approvalRequired;

  // Resolve agent_user_id per slug from the existing catalog (agents are provisioned users).
  const agentUserIds = useMemo(() => {
    const map = {} as Partial<Record<AgentSlug, string>>;
    for (const s of schedules) {
      if (!map[s.agent_slug]) map[s.agent_slug] = s.agent_user_id;
    }
    return map;
  }, [schedules]);

  const taskKeySuggestions = useMemo(
    () => Array.from(new Set(schedules.map((s) => s.task_key))).sort(),
    [schedules],
  );

  const configError = useMemo(() => {
    try {
      const parsed = JSON.parse(configText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'Config must be a JSON object';
      }
      return null;
    } catch {
      return 'Invalid JSON';
    }
  }, [configText]);

  // Live next-run preview through the canonical SQL cadence function.
  useEffect(() => {
    if (view !== 'advanced') return;
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(() => {
      computeNextRunAt({
        cadence,
        time_of_day: timeOfDay,
        days_of_week: cadence === 'weekly' ? daysOfWeek : null,
        day_of_month: cadence === 'monthly' ? dayOfMonth : null,
        timezone,
      })
        .then((iso) => { if (!cancelled) setNextRunPreview(iso); })
        .catch(() => { if (!cancelled) setNextRunPreview(null); })
        .finally(() => { if (!cancelled) setPreviewLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [view, cadence, timeOfDay, daysOfWeek, dayOfMonth, timezone]);

  const toggleDay = (d: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b),
    );
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!taskKey.trim() || !title.trim()) { setError('Task key and title are required'); return; }
    if (cadence === 'weekly' && daysOfWeek.length === 0) { setError('Pick at least one day of the week'); return; }
    if (configError) { setError(`Config: ${configError}`); return; }
    const agentUserId = agentUserIds[agentSlug];
    if (!agentUserId) { setError(`No provisioned user found for ${agentSlug} — seed its catalog first`); return; }

    setSaving(true);
    setError(null);
    try {
      const cadenceFields = {
        cadence,
        time_of_day: timeOfDay,
        days_of_week: cadence === 'weekly' ? daysOfWeek : null,
        day_of_month: cadence === 'monthly' ? dayOfMonth : null,
        timezone,
      };
      const common = {
        title: title.trim(),
        description: description.trim() || null,
        risk_tier: riskTier,
        output_kind: outputKind,
        approval_required: effectiveApproval,
        mode,
        config: JSON.parse(configText) as Record<string, unknown>,
      };
      const saved = isEdit
        ? await updateSchedule(schedule!.id, { ...cadenceFields, ...common, task_key: taskKey.trim() })
        : await createSchedule({
            ...cadenceFields,
            ...common,
            org_id: orgId,
            agent_user_id: agentUserId,
            agent_slug: agentSlug,
            task_key: taskKey.trim(),
            created_by_user_id: currentUserId,
          });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save schedule');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!schedule) return;
    if (!window.confirm(`Delete "${schedule.title}"? Its run history is removed with it.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteSchedule(schedule.id);
      onDeleted?.(schedule.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete schedule');
      setDeleting(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${view === 'builder' ? 'max-w-2xl' : 'max-w-lg'} mx-4 bg-hud-bg-mid rounded-xl border border-hud-bg-elev shadow-2xl max-h-[90dvh] overflow-y-auto`}>
        <div className="flex items-center justify-between gap-2 p-4 border-b border-hud-bg-card">
          <h3 className="text-lg font-semibold text-white">
            {isEdit ? 'Edit schedule' : view === 'builder' ? 'New task' : 'New schedule (advanced)'}
          </h3>
          <div className="flex items-center gap-1">
            {!isEdit && (
              <button
                type="button"
                onClick={() => setView(view === 'builder' ? 'advanced' : 'builder')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-hud-cream-dim hover:text-hud-gold-soft hover:bg-hud-bg-card transition-colors"
              >
                {view === 'builder'
                  ? <><SlidersHorizontal className="w-3.5 h-3.5" /> Advanced</>
                  : <><Sparkles className="w-3.5 h-3.5" /> Describe it instead</>}
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-hud-bg-card transition-colors">
              <X className="w-5 h-5 text-hud-cream-dim" />
            </button>
          </div>
        </div>

        {view === 'builder' ? (
          <TaskBuilder onCreated={(s) => { onSaved(s); onClose(); }} onCancel={onClose} />
        ) : (
        <form onSubmit={handleSubmit}>
          {error && (
            <div className="mx-4 mt-4 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30">
              <p className="text-sm text-hud-plum/40">{error}</p>
            </div>
          )}

          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Agent</label>
                <select
                  value={agentSlug}
                  onChange={(e) => setAgentSlug(e.target.value as AgentSlug)}
                  disabled={isEdit}
                  className={`${inputCls} ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  {AGENT_OPTIONS.map((a) => (
                    <option key={a.slug} value={a.slug}>{a.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Task key</label>
                <input
                  type="text"
                  value={taskKey}
                  onChange={(e) => setTaskKey(e.target.value)}
                  placeholder={`${agentSlug}.my_task`}
                  list="agent-task-key-suggestions"
                  className={inputCls}
                />
                <datalist id="agent-task-key-suggestions">
                  {taskKeySuggestions.map((k) => <option key={k} value={k} />)}
                </datalist>
              </div>
            </div>

            <div>
              <label className={labelCls}>Title</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="What this schedule does" className={inputCls} />
            </div>

            <div>
              <label className={labelCls}>Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                rows={2} className={inputCls} placeholder="Optional details for the run card" />
            </div>

            <div>
              <label className={labelCls}>Cadence</label>
              <div className="grid grid-cols-2 gap-3">
                <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} className={inputCls}>
                  {CADENCE_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} className={inputCls} />
              </div>

              {cadence === 'weekly' && (
                <div className="flex gap-1.5 mt-2">
                  {DOW.map((d, i) => (
                    <button key={d} type="button" onClick={() => toggleDay(i)}
                      className={`flex-1 px-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        daysOfWeek.includes(i)
                          ? 'bg-hud-gold/20 text-hud-gold-soft border-hud-gold/40'
                          : 'bg-hud-bg-card text-hud-cream-dim border-hud-bg-elev hover:border-hud-cream-mute'
                      }`}>
                      {d}
                    </button>
                  ))}
                </div>
              )}

              {cadence === 'monthly' && (
                <div className="mt-2">
                  <label className={labelCls}>Day of month</label>
                  <input type="number" min={1} max={31} value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
                    className={inputCls} />
                </div>
              )}

              <p className="flex items-center gap-1.5 text-xs text-hud-cream-mute mt-2">
                <CalendarClock className="w-3.5 h-3.5 text-hud-gold-soft" />
                {previewLoading
                  ? 'Computing next run…'
                  : nextRunPreview
                    ? `Next run: ${new Date(nextRunPreview).toLocaleString()} (${timezone})`
                    : 'Next run preview unavailable'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Risk tier</label>
                <select value={riskTier} onChange={(e) => setRiskTier(e.target.value as RiskTier)} className={inputCls}>
                  {RISK_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Output</label>
                <select value={outputKind} onChange={(e) => setOutputKind(e.target.value as OutputKind)} className={inputCls}>
                  {OUTPUT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <label className={`flex items-center gap-2 text-sm ${clientVisible ? 'text-hud-cream-mute' : 'text-hud-cream-soft'}`}>
              <input
                type="checkbox"
                checked={effectiveApproval}
                disabled={clientVisible}
                onChange={(e) => setApprovalRequired(e.target.checked)}
                className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
              />
              Approval required before output is delivered
              {clientVisible && <span className="text-xs text-hud-gold-soft">(forced for client-visible)</span>}
            </label>

            <div>
              <label className={labelCls}>Mode</label>
              <div className="grid grid-cols-3 gap-2">
                {MODE_OPTIONS.map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold uppercase tracking-wide border transition-colors ${
                      mode === m
                        ? 'bg-hud-gold/20 text-hud-gold-soft border-hud-gold/40'
                        : 'bg-hud-bg-card text-hud-cream-dim border-hud-bg-elev hover:border-hud-cream-mute'
                    }`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className={labelCls}>Config (JSON)</label>
              <textarea
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
                rows={4}
                spellCheck={false}
                className={`${inputCls} font-mono text-xs ${configError ? 'border-hud-plum/60 focus:ring-hud-plum' : ''}`}
              />
              {configError && <p className="text-xs text-hud-plum mt-1">{configError}</p>}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 p-4 border-t border-hud-bg-card">
            {isEdit ? (
              <button type="button" onClick={handleDelete} disabled={deleting || saving}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-hud-plum hover:bg-hud-plum/10 transition-colors disabled:opacity-50">
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete
              </button>
            ) : <span />}
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-hud-cream-soft hover:bg-hud-bg-card transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={saving || deleting || !!configError}
                className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all font-medium text-sm disabled:opacity-50">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? 'Save changes' : 'Create schedule'}
              </button>
            </div>
          </div>
        </form>
        )}
      </div>
    </div></Portal>
  );
}
