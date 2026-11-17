import { Shield, ShieldCheck, Users, UserCog, Headphones, Eye } from 'lucide-react';

interface RoleBadgeProps {
  roleName: string;
  size?: 'sm' | 'md';
  showIcon?: boolean;
}

const roleConfig: Record<string, {
  bg: string;
  text: string;
  border: string;
  icon: typeof Shield;
}> = {
  SuperAdmin: {
    bg: 'bg-hud-plum/10',
    text: 'text-hud-plum',
    border: 'border-hud-plum/20',
    icon: ShieldCheck,
  },
  Admin: {
    bg: 'bg-hud-rust/10',
    text: 'text-hud-rust',
    border: 'border-hud-rust/20',
    icon: Shield,
  },
  Manager: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    border: 'border-blue-500/20',
    icon: UserCog,
  },
  'Team Lead': {
    bg: 'bg-hud-teal/10',
    text: 'text-hud-teal',
    border: 'border-hud-teal/20',
    icon: Users,
  },
  Agent: {
    bg: 'bg-hud-cream-mute/10',
    text: 'text-hud-cream-soft',
    border: 'border-hud-cream-mute/20',
    icon: Headphones,
  },
  ReadOnly: {
    bg: 'bg-hud-cream-mute/10',
    text: 'text-hud-cream-dim',
    border: 'border-hud-cream-mute/20',
    icon: Eye,
  },
};

const defaultConfig = {
  bg: 'bg-hud-cream-mute/10',
  text: 'text-hud-cream-dim',
  border: 'border-hud-cream-mute/20',
  icon: Users,
};

export function RoleBadge({ roleName, size = 'sm', showIcon = true }: RoleBadgeProps) {
  const config = roleConfig[roleName] || defaultConfig;
  const Icon = config.icon;

  const sizeClasses = size === 'sm'
    ? 'text-xs px-2 py-0.5'
    : 'text-sm px-2.5 py-1';

  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${config.bg} ${config.text} ${config.border} ${sizeClasses}`}
    >
      {showIcon && <Icon className={iconSize} />}
      {roleName}
    </span>
  );
}
