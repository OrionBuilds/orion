/** Display formatting and chart theme shared by the Agent Health panels. */

/** Chart colours drawn from the Orion OS palette (src/index.css). */
export const HUD = {
  gold: '#dc2626',
  teal: '#14b8a6',
  emerald: '#22c55e',
  plum: '#ef4444',
  rust: '#f59e0b',
  creamDim: '#b1b4ba',
  creamMute: '#85888e',
  grid: 'rgba(255, 255, 255, 0.08)',
};

export const SERIES = [HUD.gold, HUD.emerald, HUD.rust, HUD.teal, '#f97316', HUD.creamDim];

export const tooltipStyle = {
  backgroundColor: '#232528',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  borderRadius: '8px',
  color: '#f3f3f4',
  fontSize: 12,
};

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
