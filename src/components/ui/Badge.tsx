import type { HTMLAttributes, ReactNode } from 'react';

type BadgeTone = 'good' | 'warn' | 'bad' | 'muted' | 'accent';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: BadgeTone;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  good: 'text-hud-emerald bg-hud-emerald/10 border-hud-emerald/30',
  warn: 'text-hud-rust bg-hud-rust/10 border-hud-rust/30',
  bad: 'text-hud-plum bg-hud-plum/10 border-hud-plum/30',
  muted: 'text-hud-cream-mute bg-hud-bg-elev border-hud-line-soft',
  accent: 'text-hud-gold bg-hud-gold/10 border-hud-gold/30',
};

export function Badge({ children, tone = 'muted', className = '', ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
        'text-[11px] font-bold uppercase tracking-wide',
        TONE_CLASSES[tone],
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </span>
  );
}
