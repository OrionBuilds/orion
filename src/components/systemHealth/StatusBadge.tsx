import { AlertTriangle, CheckCircle2, CircleDashed, MinusCircle, XCircle } from 'lucide-react';
import type { RowStatus } from '../../lib/systemHealth/view';

const STYLES: Record<RowStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: 'Pass', cls: 'bg-hud-emerald/10 text-hud-emerald border-hud-emerald/30', Icon: CheckCircle2 },
  warn: { label: 'Warn', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', Icon: AlertTriangle },
  fail: { label: 'Fail', cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30', Icon: XCircle },
  skip: { label: 'Skip', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30', Icon: MinusCircle },
  not_run: { label: 'Not run', cls: 'bg-slate-800/60 text-slate-500 border-slate-700', Icon: CircleDashed },
};

export function StatusBadge({ status, compact = false }: { status: RowStatus; compact?: boolean }) {
  const s = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium ${s.cls}`}>
      <s.Icon className="h-3.5 w-3.5" aria-hidden />
      {!compact && s.label}
    </span>
  );
}
