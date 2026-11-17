import type { ReactNode } from 'react';

type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  success: 'bg-hud-emerald/10 text-hud-emerald',
  warning: 'bg-hud-rust/10 text-hud-rust',
  error: 'bg-hud-plum/10 text-hud-plum',
  info: 'bg-hud-gold/10 text-hud-gold-soft',
  neutral: 'bg-hud-cream-mute/10 text-hud-cream-dim',
};

export function Badge({ variant = 'neutral', children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${variantStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
