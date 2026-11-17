import type { ComponentProps } from 'react';
import { Phone, Mail, PhoneCall, MessageCircle, LayoutDashboard } from 'lucide-react';
import type { MessageChannel } from '../../types';

interface ChannelIconProps {
  channel?: MessageChannel;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

const channelConfig: Record<MessageChannel, { icon: typeof Phone; color: string; label: string }> = {
  sms: { icon: Phone, color: 'text-hud-gold-soft', label: 'SMS' },
  email: { icon: Mail, color: 'text-blue-400', label: 'Email' },
  voice: { icon: PhoneCall, color: 'text-hud-teal', label: 'Voice' },
  webchat: { icon: MessageCircle, color: 'text-sky-400', label: 'Webchat' },
  portal: { icon: LayoutDashboard, color: 'text-hud-gold', label: 'Client portal' },
};

const sizeClasses = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

export function ChannelIcon({ channel, size = 'sm', showLabel = false }: ChannelIconProps) {
  const config = channel ? channelConfig[channel] : channelConfig.sms;
  const Icon = config.icon;
  const label = config.label;

  if (showLabel) {
    return (
      <span className={`inline-flex items-center gap-1 ${config.color}`}>
        <Icon className={sizeClasses[size]} />
        <span className="text-xs">{label}</span>
      </span>
    );
  }

  // lucide-react's props type omits `title`, but it spreads unknown props onto the <svg>,
  // so `title` renders as an svg attribute (browser tooltip). Spread-cast keeps that DOM identical.
  const titleProp = { title: label } as unknown as Partial<ComponentProps<typeof Icon>>;
  return <Icon className={`${sizeClasses[size]} ${config.color}`} {...titleProp} />;
}

interface ChannelBadgeProps {
  channel: MessageChannel;
  variant?: 'filled' | 'outline';
}

export function ChannelBadge({ channel, variant = 'filled' }: ChannelBadgeProps) {
  const config = channelConfig[channel];
  const Icon = config.icon;
  const label = config.label;

  const baseClasses = 'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium';
  const variantClasses = variant === 'filled'
    ? 'bg-hud-bg-elev text-hud-cream-soft'
    : `border border-hud-cream-mute ${config.color}`;

  return (
    <span className={`${baseClasses} ${variantClasses}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

interface MultiChannelIndicatorProps {
  channels: MessageChannel[];
  maxDisplay?: number;
}

export function MultiChannelIndicator({ channels, maxDisplay = 3 }: MultiChannelIndicatorProps) {
  const uniqueChannels = [...new Set(channels)];
  const displayChannels = uniqueChannels.slice(0, maxDisplay);
  const remaining = uniqueChannels.length - maxDisplay;

  return (
    <div className="flex items-center gap-1">
      {displayChannels.map((channel) => {
        const config = channelConfig[channel];
        const Icon = config.icon;
        return (
          <div
            key={channel}
            className={`w-5 h-5 rounded-full bg-hud-bg-elev flex items-center justify-center ${config.color}`}
            title={config.label}
          >
            <Icon className="w-3 h-3" />
          </div>
        );
      })}
      {remaining > 0 && (
        <span className="text-xs text-hud-cream-mute">+{remaining}</span>
      )}
    </div>
  );
}
