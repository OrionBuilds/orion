import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { Badge, EmptyNote, ErrorNote, Panel } from '../agent-health/ui';
import {
  actionRows, agentLabel, effectiveMode, listAutonomyPolicies, listPlaybooks, resetAutonomyMode, setAutonomyMode, userNames,
  type ActionRow, type AutonomyMode, type AutonomyPolicy,
} from '../../services/factory';
import { reportBackgroundError } from '../../lib/errors';
import { when } from './format';

const MODES: Array<{ id: AutonomyMode; label: string; hint: string; active: string }> = [
  { id: 'approval', label: 'Approval', hint: 'Agent drafts, you approve in Approvals', active: 'bg-hud-rust/20 text-hud-rust' },
  { id: 'auto', label: 'Auto', hint: 'Agent does it without asking', active: 'bg-hud-emerald/20 text-hud-emerald' },
  { id: 'off', label: 'Off', hint: 'Step is skipped', active: 'bg-hud-bg-elev text-hud-cream' },
];

/**
 * One row per action_key the playbooks use. No policy row = the default rule (outward drafts and
 * finance.* ask, internal work runs); a row overrides it. Reset deletes the row.
 */
export function AutonomyTab({ orgId, userId, userName, canManage, refreshKey }: {
  orgId: string; userId: string; userName: string; canManage: boolean; refreshKey: number;
}) {
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [policies, setPolicies] = useState<Map<string, AutonomyPolicy>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, pol] = await Promise.all([listPlaybooks(orgId), listAutonomyPolicies(orgId)]);
      setRows(actionRows(p));
      setPolicies(new Map(pol.map((x) => [x.action_key, x])));
      const ids = [...new Set(pol.map((x) => x.decided_by).filter((x): x is string => !!x))];
      setNames(await userNames(ids).catch(() => new Map<string, string>()));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const decided = useMemo(() => rows.filter((r) => policies.has(r.action_key)).length, [rows, policies]);

  const choose = async (row: ActionRow, mode: AutonomyMode) => {
    if (!canManage) return;
    if (mode === 'auto' && row.default === 'approval' && !window.confirm(
      `Let the agents do "${row.action_key}" on their own?\n\n`
      + `This action ${row.deliverables.some((d) => d === 'email_draft' || d === 'post_draft') ? 'sends email or publishes posts' : 'touches money'}. `
      + 'On Auto it goes out without asking you first, every time a playbook reaches it.')) return;
    setSaving(row.action_key);
    try {
      await setAutonomyMode(orgId, userId, row.action_key, mode);
      setPolicies((prev) => new Map(prev).set(row.action_key, {
        action_key: row.action_key, mode, note: prev.get(row.action_key)?.note ?? null, decided_by: userId, decided_at: new Date().toISOString(),
      }));
      setNames((prev) => new Map(prev).set(userId, userName));
    } catch (err) {
      reportBackgroundError('factory.autonomy')(err);
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const reset = async (row: ActionRow) => {
    setSaving(row.action_key);
    try {
      await resetAutonomyMode(orgId, row.action_key);
      setPolicies((prev) => { const next = new Map(prev); next.delete(row.action_key); return next; });
    } catch (err) {
      reportBackgroundError('factory.autonomy')(err);
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  if (loading && !rows.length) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-hud-gold" /></div>;

  return (
    <>
      {error && <ErrorNote message={error} />}
      <Panel title={`Actions (${decided}/${rows.length} decided)`}
        actions={<span className="text-xs text-hud-cream-mute">Default: emails, posts and finance ask first; internal work runs on its own.</span>}>
        {rows.length === 0 ? <EmptyNote>No playbook steps yet, so there is nothing to decide.</EmptyNote> : (
          <ul className="divide-y divide-hud-line-soft">
            {rows.map((r) => {
              const policy = policies.get(r.action_key);
              const mode = effectiveMode(policy, r.default);
              return (
                <li key={r.action_key} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-hud-mono text-sm text-hud-cream">{r.action_key}</span>
                      {r.deliverables.map((d) => <Badge key={d}>{d.replace(/_/g, ' ')}</Badge>)}
                      <Badge tone={r.default === 'approval' ? 'warn' : 'muted'}>default: {r.default}</Badge>
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-hud-cream-dim">
                      {r.steps.map((s, i) => <li key={i}>{s.playbook} · {s.title} <span className="text-hud-cream-mute">({agentLabel(s.agent)})</span></li>)}
                    </ul>
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-1 lg:items-end">
                    <div className="inline-flex rounded-lg border border-hud-line-soft p-0.5" role="radiogroup" aria-label={`${r.action_key} autonomy`}>
                      {MODES.map((m) => (
                        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} title={m.hint}
                          disabled={!canManage || saving === r.action_key} onClick={() => mode !== m.id && void choose(r, m.id)}
                          className={`rounded-md px-2.5 py-1 text-xs disabled:cursor-not-allowed ${mode === m.id ? m.active : 'text-hud-cream-dim hover:text-hud-cream'} ${!canManage ? 'opacity-70' : ''}`}>
                          {m.label}
                        </button>))}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-hud-cream-mute">
                      {policy
                        ? <>
                          <span>{names.get(policy.decided_by ?? '') ?? 'Decided'} · {when(policy.decided_at)}</span>
                          {canManage && (
                            <button type="button" disabled={saving === r.action_key} onClick={() => void reset(r)}
                              className="inline-flex items-center gap-1 text-hud-cream-dim hover:text-hud-cream disabled:opacity-50"><RotateCcw size={11} /> Reset to default</button>
                          )}
                        </>
                        : <span>Not decided: using the default</span>}
                      {saving === r.action_key && <Loader2 className="h-3 w-3 animate-spin" />}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
