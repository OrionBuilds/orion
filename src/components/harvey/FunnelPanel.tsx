import { useEffect, useState } from 'react';
import { Filter, Loader2 } from 'lucide-react';
import { Badge, EmptyNote, ErrorNote, Panel } from '../agent-health/ui';
import type { HarveyProspect } from '../../services/harvey';
import { applyFilters, funnelSteps, getFunnel, type HarveyFunnel, type HarveySearch } from '../../services/harveyGrowth';

const RANGES = [{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 365, label: '12 months' }];
const CHANNEL_LABEL: Record<string, string> = { email: 'Email', linkedin: 'LinkedIn', sms: 'SMS' };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—');

/**
 * Prospects -> contacted -> replied -> interested -> booked, for everyone or for one saved search.
 * A booking counts for HARVEY when the prospect's email matches a contact with a live appointment
 * created after he first reached out.
 */
export function FunnelPanel({ orgId, prospects, searches }: { orgId: string; prospects: HarveyProspect[]; searches: HarveySearch[] }) {
  const [days, setDays] = useState(90);
  const [searchId, setSearchId] = useState('');
  const [funnel, setFunnel] = useState<HarveyFunnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const search = searches.find((s) => s.id === searchId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const ids = search ? applyFilters(prospects, search.filters).map((p) => p.prospect_id) : null;
    // A saved search that matches nobody must give an empty funnel, not the whole pipeline.
    getFunnel(orgId, days, ids === null ? null : ids.length ? ids : ['__none__'])
      .then((f) => { if (!cancelled) { setFunnel(f); setError(null); } })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgId, days, search, prospects]);

  if (error) return <ErrorNote message={error} />;
  const steps = funnel ? funnelSteps(funnel) : [];
  const top = Math.max(1, ...steps.map((s) => s.n));
  const channels = funnel ? Object.entries(funnel.by_channel) : [];

  return (
    <div className="space-y-4">
      <Panel title="Funnel" icon={<Filter size={14} />}
        actions={
          <span className="flex items-center gap-2">
            <select value={searchId} onChange={(e) => setSearchId(e.target.value)} aria-label="Saved search"
              className="rounded-md border border-hud-line-soft bg-hud-bg-elev px-2 py-1 text-xs text-hud-cream">
              <option value="">All prospects</option>
              {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Time range"
              className="rounded-md border border-hud-line-soft bg-hud-bg-elev px-2 py-1 text-xs text-hud-cream">
              {RANGES.map((r) => <option key={r.days} value={r.days}>Last {r.label}</option>)}
            </select>
          </span>}>
        {loading && !funnel ? <div className="flex h-24 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-hud-gold" /></div>
          : !funnel || funnel.prospects === 0 ? <EmptyNote>No prospects in this selection.</EmptyNote> : (
            <ul className="space-y-2">
              {steps.map((s) => (
                <li key={s.key}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-hud-cream-soft">{s.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-hud-mono text-hud-cream">{s.n}</span>
                      {s.pctOfPrevious != null && <span className="w-24 text-right text-xs text-hud-cream-mute">{s.pctOfPrevious}% of previous</span>}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-hud-bg-elev">
                    <div className={`h-full ${s.key === 'booked' ? 'bg-hud-emerald' : 'bg-hud-gold'}`} style={{ width: `${Math.max(s.n > 0 ? 2 : 0, Math.round((s.n / top) * 100))}%` }} />
                  </div>
                </li>))}
            </ul>)}
        {funnel && funnel.contacted > 0 && (
          <p className="mt-3 text-xs text-hud-cream-mute">
            Of {funnel.contacted} contacted: {steps[2].pctOfContacted ?? 0}% replied, {steps[3].pctOfContacted ?? 0}% interested, {steps[4].pctOfContacted ?? 0}% booked.
            Counts cover people HARVEY reached in the last {RANGES.find((r) => r.days === days)?.label}.
          </p>)}
      </Panel>

      {funnel && channels.length > 0 && (
        <Panel title="By channel">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-hud-cream-mute"><tr><th className="py-1.5">Channel</th><th>Contacted</th><th>Replied</th><th>Reply rate</th></tr></thead>
            <tbody className="divide-y divide-hud-line-soft">
              {channels.map(([ch, v]) => (
                <tr key={ch}>
                  <td className="py-2 text-hud-cream">{CHANNEL_LABEL[ch] ?? ch}</td>
                  <td className="font-hud-mono text-hud-cream-soft">{v.contacted}</td>
                  <td className="font-hud-mono text-hud-cream-soft">{v.replied}</td>
                  <td className="text-hud-cream-dim">{v.contacted ? `${Math.round((v.replied / v.contacted) * 100)}%` : '—'}</td>
                </tr>))}
            </tbody>
          </table>
        </Panel>)}

      {funnel && (
        <Panel title={`Meetings booked (${funnel.booked})`}>
          {funnel.bookings.length === 0 ? <EmptyNote>No meetings credited to HARVEY in this period.</EmptyNote> : (
            <ul className="divide-y divide-hud-line-soft">
              {funnel.bookings.map((b) => (
                <li key={b.prospect_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-hud-cream">{b.name} <span className="text-hud-cream-mute">· {b.company}</span></span>
                  <span className="flex items-center gap-2 text-xs text-hud-cream-dim">
                    <Badge tone="ok">meeting {day(b.meeting_at)}</Badge>
                    <span>first contacted {day(b.first_contacted_at)}</span>
                  </span>
                </li>))}
            </ul>)}
          <p className="mt-2 text-xs text-hud-cream-mute">Matched by email: a contact with a live appointment booked after HARVEY first reached out.</p>
        </Panel>)}
    </div>
  );
}
