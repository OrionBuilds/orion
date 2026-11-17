import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { assessPilot, getShadowRunsToReview, reviewShadowRun, type PilotRow, type PilotVerdict, type ReviewVerdict, type ShadowRunToReview } from '../../services/agentPilot';
import { agentLabel } from '../../services/agentOps';
import { EmptyNote, ErrorNote, Panel } from './ui';

const VERDICT: Record<PilotVerdict, { label: string; cls: string }> = {
  collecting: { label: 'Collecting', cls: 'text-hud-cream-dim' },
  ready_to_graduate: { label: 'Ready to graduate', cls: 'text-hud-emerald' },
  kill_review: { label: 'Kill review', cls: 'text-hud-plum' },
  permanent_checkpoint: { label: 'Permanent checkpoint', cls: 'text-hud-cream-mute' },
  active_ok: { label: 'Active', cls: 'text-hud-emerald' },
  active_slipping: { label: 'Active, slipping', cls: 'text-hud-rust' },
};

function ShadowReview({ orgId, scheduleId, onChanged }: { orgId: string; scheduleId: string; onChanged: () => void }) {
  const [runs, setRuns] = useState<ShadowRunToReview[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setRuns(await getShadowRunsToReview(orgId, scheduleId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const verdict = async (runId: string, v: ReviewVerdict) => {
    setBusy(runId);
    try {
      await reviewShadowRun(orgId, runId, v);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (runs === null) {
    return <button type="button" onClick={() => void load()} className="mt-1 text-xs text-hud-gold hover:underline">Review shadow drafts</button>;
  }
  return (
    <div className="mt-2 space-y-2">
      {error && <ErrorNote message={error} />}
      {runs.length === 0 ? <p className="text-xs text-hud-cream-mute">No shadow drafts waiting for a verdict.</p> : runs.map((r) => (
        <div key={r.run_id} className="rounded-lg border border-hud-line-soft p-2">
          <div className="text-[11px] text-hud-cream-mute">{new Date(r.scheduled_for).toLocaleString()}</div>
          {r.summary && <p className="whitespace-pre-wrap text-xs text-hud-cream">{r.summary}</p>}
          {r.proposed && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-hud-cream-dim">{r.proposed}</pre>}
          <div className="mt-1 flex gap-2">
            {(['approved', 'edited', 'rejected'] as ReviewVerdict[]).map((v) => (
              <button
                key={v}
                type="button"
                disabled={busy === r.run_id}
                onClick={() => void verdict(r.run_id, v)}
                className="rounded-md border border-hud-line-soft px-2 py-0.5 text-[11px] text-hud-cream hover:bg-hud-bg-elev disabled:opacity-50"
              >
                {v === 'approved' ? 'Fine as is' : v === 'edited' ? 'Needed edits' : 'Wrong'}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PilotsTab({ orgId, pilots, days, onDays, loading, onChanged, canManage }: {
  orgId: string; pilots: PilotRow[] | null; days: number; onDays: (d: number) => void; loading: boolean; onChanged: () => void; canManage: boolean;
}) {
  return (
    <Panel
      title="Pilots: should this task graduate?"
      actions={
        <select
          value={days}
          onChange={(e) => onDays(Number(e.target.value))}
          className="rounded-md border border-hud-line-soft bg-hud-bg-card px-2 py-1 text-xs text-hud-cream"
          aria-label="Window"
        >
          {[14, 30, 60, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      }
    >
      <p className="mb-3 text-xs text-hud-cream-mute">
        Counts come from drafts a person approved, edited, rejected or let expire. Shadow runs never reach the approval queue, so review their drafts here: only "Fine as is" counts as approved untouched. This page never changes a schedule: promoting a task from shadow to active stays your decision.
      </p>
      {loading && !pilots ? (
        <div className="flex h-24 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-hud-gold" /></div>
      ) : !pilots || pilots.length === 0 ? (
        <EmptyNote>No shadow or active scheduled tasks.</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-hud-cream-mute">
                <th className="py-1 pr-3">Task</th><th className="pr-3">Mode</th><th className="pr-3">Runs</th><th className="pr-3">Failed</th><th className="pr-3">Untouched</th><th className="pr-3">Edited</th>
                <th className="pr-3">Rejected</th><th className="pr-3">Expired</th><th className="pr-3">Pending</th><th className="pr-3">Rate</th><th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {pilots.map((p) => {
                const a = assessPilot(p);
                const v = VERDICT[a.verdict];
                return (
                  <tr key={p.schedule_id} className="border-t border-hud-line-soft align-top">
                    <td className="py-2 pr-3 text-hud-cream">
                      {agentLabel(p.agent_slug)} · {p.title}
                      {canManage && p.pending > 0 && <ShadowReview orgId={orgId} scheduleId={p.schedule_id} onChanged={onChanged} />}
                    </td>
                    <td className="pr-3 text-hud-cream-dim">{p.mode}</td>
                    <td className="pr-3 text-hud-cream-dim">{p.runs}</td>
                    <td className={`pr-3 ${p.failed > 0 ? 'text-hud-rust' : 'text-hud-cream-dim'}`}>{p.failed}</td>
                    <td className="pr-3 text-hud-cream">{p.approved}</td>
                    <td className="pr-3 text-hud-cream">{p.edited}</td>
                    <td className="pr-3 text-hud-cream">{p.rejected}</td>
                    <td className="pr-3 text-hud-cream">{p.expired}</td>
                    <td className="pr-3 text-hud-cream-dim">{p.pending}</td>
                    <td className="pr-3 text-hud-cream">{a.approvalRate === null ? '—' : `${Math.round(a.approvalRate * 100)}%`}</td>
                    <td>
                      <div className={`font-medium ${v.cls}`}>{v.label}</div>
                      <div className="text-xs text-hud-cream-mute">{a.note}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
