import { ShieldCheck } from 'lucide-react';
import { Badge, EmptyNote, Panel } from '../agent-health/ui';
import type { SafetyLimit } from '../../services/harvey';
import { limitTone } from '../../services/harveyGrowth';

const BAR: Record<string, string> = { ok: 'bg-hud-emerald', warn: 'bg-hud-rust', bad: 'bg-hud-plum', muted: 'bg-hud-cream-mute' };
const WORD: Record<string, string> = { ok: 'ok', near: 'near the limit', full: 'limit reached', tripped: 'paused by safety stop' };

/** The ceilings Harvey enforces on every channel, with what he has used so far. */
export function SafetyPanel({ limits }: { limits: SafetyLimit[] | undefined }) {
  return (
    <Panel title="Safety limits" icon={<ShieldCheck size={14} />}>
      {!limits || limits.length === 0 ? <EmptyNote>HARVEY has not reported his limits yet.</EmptyNote> : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {limits.map((l) => {
            const tone = limitTone(l.state);
            const pct = l.cap > 0 ? Math.min(100, Math.round((l.used / l.cap) * 100)) : 0;
            return (
              <li key={l.channel}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-hud-cream-soft">{l.label}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-hud-mono text-hud-cream">{l.used}/{l.cap}</span>
                    {l.state !== 'ok' && <Badge tone={tone === 'warn' ? 'warn' : 'bad'}>{WORD[l.state] ?? l.state}</Badge>}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hud-bg-elev" role="progressbar" aria-valuenow={l.used} aria-valuemax={l.cap} aria-label={l.label}>
                  <div className={`h-full ${BAR[tone]}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-0.5 text-[11px] text-hud-cream-mute">{l.period === 'week' ? 'rolling 7 days' : 'today'}</div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
