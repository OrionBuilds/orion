export const when = (iso: string | null | undefined) =>
  (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export const selectCls = 'rounded-md border border-hud-line-soft bg-hud-bg-elev px-2 py-1 text-xs text-hud-cream';
