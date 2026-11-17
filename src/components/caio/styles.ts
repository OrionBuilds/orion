/** Shared Tailwind class strings for the CAIO staff UI (hud-* tokens, same look as the Factory forms). */
export const inputCls = 'w-full rounded-lg border border-hud-bg-elev bg-hud-bg-card px-3 py-2 text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/40 disabled:opacity-60';
export const labelCls = 'mb-1 block text-xs font-medium text-hud-cream-dim';
export const btnPrimary = 'inline-flex items-center justify-center gap-2 rounded-lg bg-hud-gold px-3 py-2 text-sm font-medium text-hud-bg-deep hover:bg-hud-gold-soft disabled:cursor-not-allowed disabled:opacity-50';
export const btnGhost = 'inline-flex items-center justify-center gap-2 rounded-lg border border-hud-line-soft bg-hud-bg-card px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev disabled:cursor-not-allowed disabled:opacity-50';
export const btnDanger = 'inline-flex items-center justify-center gap-2 rounded-lg border border-hud-plum/40 bg-hud-plum/10 px-3 py-2 text-sm text-hud-plum hover:bg-hud-plum/20 disabled:cursor-not-allowed disabled:opacity-50';
export const linkCls = 'text-hud-teal underline-offset-2 hover:underline';

/** The sub-tabs of the per-project CAIO tab (`?caio=`). */
export type CaioSubTab = 'overview' | 'registers' | 'documents' | 'gates' | 'settings';
export type CaioNavigate = (tab: CaioSubTab, opts?: { register?: string }) => void;
