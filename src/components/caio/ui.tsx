/** Small shared pieces for the CAIO module. Other CAIO files import from here; do not fork these. */
import { Badge } from '../ui/Badge';
import { daysUntil, dueTone, type Tone } from '../../services/caio';

export const formatDate = (d: string | null | undefined): string => {
  if (!d) return '–';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** A date with a tone: overdue = red, within two weeks = amber. */
export function DueBadge({ date, label }: { date: string | null; label?: string }) {
  if (!date) return <span className="text-hud-cream-mute">–</span>;
  const d = daysUntil(date);
  const rel = d === null ? '' : d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`;
  return <Badge tone={dueTone(date) as Tone === 'muted' ? 'muted' : (dueTone(date) as 'good' | 'warn' | 'bad')}>{label ? `${label} ` : ''}{formatDate(date)} · {rel}</Badge>;
}

export function ToneBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <Badge tone={tone}>{children}</Badge>;
}

/** Plain text error box. */
export function ErrorBox({ message }: { message: string }) {
  return <div role="alert" className="rounded-lg border border-hud-plum/40 bg-hud-plum/10 px-3 py-2 text-sm text-hud-cream-soft">{message}</div>;
}
