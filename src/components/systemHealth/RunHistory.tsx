import { Download, History } from 'lucide-react';
import type { HealthRunRow } from '../../services/systemHealth';
import { StatusBadge } from './StatusBadge';

interface Props {
  rows: HealthRunRow[];
  unavailable: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExport: (id: string) => void;
}

export function RunHistory({ rows, unavailable, selectedId, onSelect, onExport }: Props) {
  return (
    <section className="rounded-xl border border-hud-bg-elev bg-hud-bg-card/50">
      <header className="flex items-center gap-2 border-b border-hud-bg-elev px-4 py-3">
        <History className="h-5 w-5 text-hud-gold-soft" aria-hidden />
        <h3 className="font-semibold text-white">Run history</h3>
      </header>
      {unavailable ? (
        <p className="px-4 py-4 text-sm text-hud-cream-dim">
          History is unavailable until migration <code>20261029210000_system_health.sql</code> is applied.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-hud-cream-dim">No runs yet.</p>
      ) : (
        <div className="max-h-72 overflow-auto overscroll-contain">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="sticky top-0 bg-hud-bg-card text-xs uppercase tracking-wide text-hud-cream-dim">
              <tr>
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Groups</th>
                <th className="px-4 py-2 font-medium">Mode</th>
                <th className="px-4 py-2 font-medium">Pass / warn / fail</th>
                <th className="px-4 py-2 font-medium">Duration</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => onSelect(r.id)}
                  className={`cursor-pointer border-t border-hud-bg-elev/60 hover:bg-hud-bg-elev/40 ${selectedId === r.id ? 'bg-hud-bg-elev/60' : ''}`}
                >
                  <td className="whitespace-nowrap px-4 py-2 text-white">{new Date(r.started_at).toLocaleString()}</td>
                  <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-2 text-hud-cream-soft">{r.groups.join(', ')}</td>
                  <td className="px-4 py-2 text-hud-cream-soft">{r.mode === 'rls' ? 'As my user (RLS)' : 'Service'}</td>
                  <td className="px-4 py-2 tabular-nums">
                    <span className="text-hud-emerald">{r.pass_count}</span>
                    {' / '}
                    <span className="text-amber-300">{r.warn_count}</span>
                    {' / '}
                    <span className="text-rose-300">{r.fail_count}</span>
                  </td>
                  <td className="px-4 py-2 tabular-nums text-hud-cream-dim">
                    {r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} s` : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onExport(r.id); }}
                      className="rounded p-1 text-hud-cream-dim hover:bg-hud-bg-elev hover:text-white"
                      title="Export this run as JSON"
                      aria-label="Export run as JSON"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
