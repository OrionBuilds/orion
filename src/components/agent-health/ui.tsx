import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, CircleOff, Info, XCircle } from 'lucide-react';
import type { Alert, StatusLevel } from '../../services/agentOps';

export function Panel({ title, icon, actions, children, className = '' }: {
  title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-xl border border-hud-line-soft bg-hud-bg-card/70 p-4 ${className}`}>
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && (
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-hud-cream-dim">
              {icon}
              {title}
            </h3>
          )}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default' }: {
  label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'ok' | 'bad' | 'warn';
}) {
  const color = tone === 'ok' ? 'text-hud-emerald' : tone === 'bad' ? 'text-hud-plum' : tone === 'warn' ? 'text-hud-rust' : 'text-hud-cream';
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-hud-cream-mute">{label}</div>
      <div className={`mt-0.5 truncate font-hud-mono text-lg ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-hud-cream-mute">{hint}</div>}
    </div>
  );
}

const STATUS_STYLE: Record<StatusLevel, { cls: string; icon: ReactNode; label: string }> = {
  live: { cls: 'bg-hud-emerald/15 text-hud-emerald border-hud-emerald/30', icon: <CheckCircle2 size={12} />, label: 'live' },
  stale: { cls: 'bg-hud-rust/15 text-hud-rust border-hud-rust/30', icon: <AlertTriangle size={12} />, label: 'stale' },
  offline: { cls: 'bg-hud-plum/15 text-hud-plum border-hud-plum/30', icon: <CircleOff size={12} />, label: 'offline' },
  idle: { cls: 'bg-hud-bg-elev/60 text-hud-cream-mute border-hud-line-soft', icon: <CircleDashed size={12} />, label: 'idle' },
};

export function StatusPill({ level }: { level: StatusLevel }) {
  const s = STATUS_STYLE[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.icon} {s.label}
    </span>
  );
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'ok' | 'bad' | 'warn' | 'muted' | 'info' }) {
  const cls = {
    ok: 'bg-hud-emerald/15 text-hud-emerald',
    bad: 'bg-hud-plum/15 text-hud-plum',
    warn: 'bg-hud-rust/15 text-hud-rust',
    info: 'bg-hud-gold/15 text-hud-gold-soft',
    muted: 'bg-hud-bg-elev text-hud-cream-dim',
  }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

export function AlertRow({ alert }: { alert: Alert }) {
  const icon = alert.severity === 'critical'
    ? <XCircle size={14} className="mt-0.5 shrink-0 text-hud-plum" />
    : alert.severity === 'warning'
      ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-hud-rust" />
      : <Info size={14} className="mt-0.5 shrink-0 text-hud-gold-soft" />;
  return (
    <li className="flex items-start gap-2 text-sm text-hud-cream-soft">
      {icon}
      <span className="break-words">{alert.text}</span>
    </li>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-hud-line-soft px-3 py-4 text-sm text-hud-cream-mute">{children}</p>;
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-hud-plum/30 bg-hud-plum/10 px-3 py-2 text-sm text-hud-plum">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{message}</span>
    </div>
  );
}

/** Horizontal share bar, e.g. ok / failed / other run counts. */
export function SplitBar({ parts }: { parts: Array<{ value: number; color: string; label: string }> }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <div className="h-2 rounded bg-hud-bg-elev" />;
  return (
    <div className="flex h-2 overflow-hidden rounded bg-hud-bg-elev" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
      {parts.filter((p) => p.value > 0).map((p) => (
        <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.color }} title={`${p.label}: ${p.value}`} />
      ))}
    </div>
  );
}

export function RangeToggle<T extends number>({ value, options, onChange }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-hud-line-soft p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs ${o.value === value ? 'bg-hud-gold/20 text-hud-gold-soft' : 'text-hud-cream-dim hover:text-hud-cream'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
