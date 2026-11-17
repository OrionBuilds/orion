import { useState } from 'react';
import { ChevronDown, ChevronRight, Play } from 'lucide-react';
import type { CheckRowView } from '../../lib/systemHealth/view';
import { StatusBadge } from './StatusBadge';

interface Props {
  row: CheckRowView;
  /** Offered for CRUD entities: run just this one (plus its dependencies). */
  onRunOne?: (checkId: string) => void;
  disabled?: boolean;
}

export function CheckRow({ row, onRunOne, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const r = row.result;
  const hasDetail = !!r && (!!r.error || !!r.steps?.length || (r.details && Object.keys(r.details).length > 0));

  return (
    <div className={`border-b border-hud-bg-elev/60 last:border-b-0 ${row.child ? 'bg-hud-bg-mid/20' : ''}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
          aria-expanded={hasDetail ? open : undefined}
        >
          <span className="w-4 shrink-0 text-hud-cream-dim">
            {hasDetail ? (open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />) : null}
          </span>
          <StatusBadge status={row.status} compact />
          <span className={`min-w-0 flex-1 ${row.child ? 'pl-3 text-sm' : 'text-sm font-medium'} text-white`}>
            <span className="block truncate" title={row.name}>{row.name}</span>
            <span className="block truncate text-xs text-hud-cream-dim" title={r?.summary ?? row.description}>
              {r?.summary ?? row.description ?? ''}
            </span>
          </span>
        </button>
        {r && <span className="shrink-0 text-xs tabular-nums text-hud-cream-dim">{r.durationMs} ms</span>}
        {onRunOne && (
          <button
            type="button"
            onClick={() => onRunOne(row.id)}
            disabled={disabled}
            className="shrink-0 rounded p-1 text-hud-cream-dim hover:bg-hud-bg-elev hover:text-white disabled:opacity-40"
            title="Run this check"
            aria-label={`Run ${row.name}`}
          >
            <Play className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && r && (
        <div className="space-y-2 px-9 pb-3 text-xs">
          {r.error && (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-rose-500/20 bg-rose-500/10 p-2 text-rose-200">
              {r.error}
            </pre>
          )}
          {!!r.steps?.length && (
            <div className="flex flex-wrap gap-1.5">
              {r.steps.map((s, i) => (
                <span key={`${s.step}-${i}`} className="inline-flex items-center gap-1" title={s.message}>
                  <StatusBadge status={s.status} compact />
                  <span className="text-hud-cream-soft">{s.step}</span>
                  <span className="text-hud-cream-dim">{s.durationMs}ms</span>
                </span>
              ))}
            </div>
          )}
          {r.steps?.some((s) => s.message) && (
            <ul className="space-y-0.5 text-hud-cream-dim">
              {r.steps.filter((s) => s.message).map((s, i) => (
                <li key={`${s.step}-m-${i}`}><span className="text-hud-cream-soft">{s.step}:</span> {s.message}</li>
              ))}
            </ul>
          )}
          {r.details && Object.keys(r.details).length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-md bg-hud-bg-mid p-2 text-hud-cream-dim">
              {JSON.stringify(r.details, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
