import { Play, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { countStatuses, type CheckRowView } from '../../lib/systemHealth/view';
import { CheckRow } from './CheckRow';

interface Props {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  rows: CheckRowView[];
  running: boolean;
  busy: boolean;
  onRun: () => void;
  onRunOne?: (checkId: string) => void;
  /** Extra header controls (e.g. Ping agents). */
  actions?: ReactNode;
}

export function GroupPanel({ title, subtitle, icon: Icon, rows, running, busy, onRun, onRunOne, actions }: Props) {
  const c = countStatuses(rows);
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-hud-bg-elev bg-hud-bg-card/50">
      <header className="flex flex-wrap items-center gap-3 border-b border-hud-bg-elev px-4 py-3">
        <Icon className="h-5 w-5 text-hud-gold-soft" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-white">{title}</h3>
          <p className="truncate text-xs text-hud-cream-dim">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 text-xs tabular-nums">
          <span className="text-hud-emerald">{c.pass} pass</span>
          <span className="text-amber-300">{c.warn} warn</span>
          <span className="text-rose-300">{c.fail} fail</span>
          {c.not_run > 0 && <span className="text-slate-500">{c.not_run} not run</span>}
        </div>
        {actions}
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-hud-bg-elev px-3 py-1.5 text-xs font-medium text-white hover:bg-hud-bg-elev disabled:opacity-50"
        >
          {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run {title.toLowerCase()}
        </button>
      </header>
      {/* Contained scroll: long groups (cron jobs, edge functions) never stretch the page. */}
      <div className="max-h-[28rem] min-h-0 overflow-y-auto overscroll-contain">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-hud-cream-dim">No checks in this group.</p>
        ) : (
          rows.map((row) => (
            <CheckRow
              key={row.id}
              row={row}
              disabled={busy}
              onRunOne={onRunOne && row.id.startsWith('crud.') && row.id !== 'crud.cleanup' ? onRunOne : undefined}
            />
          ))
        )}
      </div>
    </section>
  );
}
