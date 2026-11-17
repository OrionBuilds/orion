import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getRuns, RUN_STATUS_TONE, type RunRow } from '../../services/agentOps';
import { Badge, EmptyNote, ErrorNote } from './ui';
import { fmtDateTime } from './format';

const FILTERS: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'ok', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'open', label: 'Open' },
];

/** Keyset-paginated run history (agent_ops_runs), 50 rows per page. */
export function RunHistory({ orgId, agentUserId }: { orgId: string; agentUserId: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before: string | null, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await getRuns(orgId, { agentUserId, status, before, limit: 50 });
      setRows((prev) => (replace ? page.rows : [...prev, ...page.rows]));
      setHasMore(page.has_more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId, agentUserId, status]);

  useEffect(() => { void load(null, true); }, [load]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setStatus(f.value)}
            className={`rounded-md px-2.5 py-1 text-xs ${status === f.value ? 'bg-hud-gold/20 text-hud-gold-soft' : 'text-hud-cream-dim hover:text-hud-cream'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error && <ErrorNote message={error} />}
      {!error && rows.length === 0 && !loading && <EmptyNote>No runs match.</EmptyNote>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-hud-cream-mute">
              <tr>
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Task</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 font-medium text-right">Duration</th>
                <th className="py-1.5 font-medium">Result / error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-line-soft">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-hud-cream-dim">{fmtDateTime(r.created_at)}</td>
                  <td className="py-1.5 pr-3 text-hud-cream">{r.title}{r.mode === 'shadow' && <span className="ml-1 text-xs text-hud-cream-mute">(shadow)</span>}</td>
                  <td className="py-1.5 pr-3"><Badge tone={RUN_STATUS_TONE[r.status] ?? 'muted'}>{r.status.replace('_', ' ')}</Badge></td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right font-hud-mono text-hud-cream-dim">{r.duration_s !== null ? `${r.duration_s}s` : '—'}</td>
                  <td className="max-w-[420px] py-1.5 text-xs">
                    {r.error ? <span className="break-words text-hud-plum">{r.error}</span> : <span className="break-words text-hud-cream-mute">{r.summary ?? ''}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex justify-center">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-hud-gold" />
        ) : hasMore ? (
          <button
            type="button"
            onClick={() => load(rows[rows.length - 1]?.created_at ?? null, false)}
            className="rounded-md border border-hud-line-soft px-3 py-1 text-xs text-hud-cream-dim hover:text-hud-cream"
          >
            Load older runs
          </button>
        ) : null}
      </div>
    </div>
  );
}
