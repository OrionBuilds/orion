import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Badge, EmptyNote, ErrorNote, Panel } from '../agent-health/ui';
import {
  agentLabel, brandLabel, defaultAutonomy, groupByStage, listPlaybooks, pipelineNames, setPlaybookEnabled, setStepEnabled,
  type Playbook,
} from '../../services/factory';
import { reportBackgroundError } from '../../lib/errors';
import { Switch } from './ui';
import { when } from './format';

const APPLIES_LABEL: Record<string, string> = { opportunity: 'Deals', project: 'Projects', org: 'Scheduled' };

/** The playbook definitions. Read-only apart from the owner's on/off switches (playbook and step). */
export function PlaybooksTab({ orgId, canManage, refreshKey }: { orgId: string; canManage: boolean; refreshKey: number }) {
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [pipelines, setPipelines] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await listPlaybooks(orgId);
      setPlaybooks(p);
      const sales = [...new Set(p.map((x) => x.sales_pipeline_id).filter((x): x is string => !!x))];
      const projects = [...new Set(p.map((x) => x.project_pipeline_id).filter((x): x is string => !!x))];
      setPipelines(await pipelineNames(sales, projects).catch(() => new Map<string, string>()));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const save = async (id: string, fn: () => Promise<void>, apply: (p: Playbook[]) => Playbook[]) => {
    setSaving(id);
    try {
      await fn();
      setPlaybooks(apply);
    } catch (err) {
      reportBackgroundError('factory.toggle')(err);
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const togglePlaybook = (p: Playbook, enabled: boolean) => {
    if (!enabled && !window.confirm(`Turn off "${p.name}"? No new runs start; runs already going keep their queued steps.`)) return;
    void save(p.id, () => setPlaybookEnabled(p.id, enabled), (all) => all.map((x) => (x.id === p.id ? { ...x, enabled } : x)));
  };

  const toggleStep = (playbookId: string, stepId: string, enabled: boolean) =>
    void save(stepId, () => setStepEnabled(stepId, enabled), (all) => all.map((x) => (x.id !== playbookId ? x
      : { ...x, steps: x.steps.map((s) => (s.id === stepId ? { ...s, enabled } : s)) })));

  if (loading && !playbooks.length) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-hud-gold" /></div>;

  return (
    <>
      {error && <ErrorNote message={error} />}
      <Panel title={`Playbooks (${playbooks.length})`}>
        {playbooks.length === 0 ? <EmptyNote>No playbooks yet.</EmptyNote> : (
          <ul className="divide-y divide-hud-line-soft">
            {playbooks.map((p) => {
              const isOpen = open.has(p.id);
              const pipelineId = p.sales_pipeline_id ?? p.project_pipeline_id;
              const where = p.applies_to === 'org'
                ? `${p.cadence ?? ''} · next ${when(p.next_run_at)}`
                : pipelineId ? `${pipelines.get(pipelineId) ?? 'pipeline'}` : 'no pipeline';
              return (
                <li key={p.id} className="py-2">
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => toggle(p.id)} aria-expanded={isOpen}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      {isOpen ? <ChevronDown size={14} className="shrink-0 text-hud-cream-mute" /> : <ChevronRight size={14} className="shrink-0 text-hud-cream-mute" />}
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-hud-cream">{p.name}</span>
                        <span className="block truncate text-xs text-hud-cream-mute">{p.description || p.slug}</span>
                      </span>
                    </button>
                    <span className="hidden shrink-0 items-center gap-1.5 text-xs text-hud-cream-dim sm:flex">
                      <Badge tone="info">{APPLIES_LABEL[p.applies_to] ?? p.applies_to}</Badge>
                      <span className="max-w-[14rem] truncate">{where}</span>
                      <Badge>{brandLabel(p.brand)}</Badge>
                      <span className="text-hud-cream-mute">{p.steps.length} steps</span>
                    </span>
                    <Switch checked={p.enabled} disabled={!canManage || saving === p.id} label={`${p.name} enabled`}
                      onChange={(v) => togglePlaybook(p, v)} />
                  </div>

                  {isOpen && (
                    <div className="mt-2 space-y-3 pl-6">
                      {groupByStage(p.steps).map((g) => (
                        <div key={g.stage}>
                          <div className="text-[10px] uppercase tracking-wider text-hud-cream-mute">{g.stage}</div>
                          <div className="overflow-x-auto">
                            <table className="w-full min-w-[720px] text-left text-sm">
                              <thead className="text-[11px] uppercase tracking-wider text-hud-cream-mute">
                                <tr><th className="py-1.5 pr-3">Step</th><th className="pr-3">Agent</th><th className="pr-3">Role</th><th className="pr-3">Deliverable</th><th className="pr-3">Action</th><th className="pr-3">Required</th><th>On</th></tr>
                              </thead>
                              <tbody className="divide-y divide-hud-line-soft">
                                {g.steps.map((s) => (
                                  <tr key={s.id} className={s.enabled ? '' : 'opacity-60'}>
                                    <td className="py-1.5 pr-3 text-hud-cream-soft" title={s.instructions}>{s.title}</td>
                                    <td className="pr-3 text-hud-cream-dim">{agentLabel(s.agent)}</td>
                                    <td className="pr-3 font-hud-mono text-xs text-hud-cream-dim">{s.role_slug ?? '—'}</td>
                                    <td className="pr-3 text-hud-cream-dim">{s.deliverable.replace(/_/g, ' ')}</td>
                                    <td className="pr-3">
                                      <span className="font-hud-mono text-xs text-hud-cream-dim">{s.action_key}</span>
                                      {defaultAutonomy(s) === 'approval' && <span className="ml-1" title="Asks for approval unless the Autonomy tab says otherwise"><Badge tone="warn">asks by default</Badge></span>}
                                    </td>
                                    <td className="pr-3 text-hud-cream-dim">{s.required ? 'yes' : 'no'}</td>
                                    <td><Switch checked={s.enabled} disabled={!canManage || saving === s.id} label={`${s.title} enabled`}
                                      onChange={(v) => toggleStep(p.id, s.id, v)} /></td>
                                  </tr>))}
                              </tbody>
                            </table>
                          </div>
                        </div>))}
                      {p.steps.length === 0 && <p className="text-xs text-hud-cream-mute">No steps.</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
