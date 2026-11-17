import type { SupportTicketStatus } from '../../types';

const STATUS_CONFIG: Record<SupportTicketStatus, { label: string; className: string }> = {
  new: { label: 'New', className: 'bg-blue-500/20 text-blue-400 border border-blue-500/30' },
  in_review: { label: 'In Review', className: 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/30' },
  in_progress: { label: 'In Progress', className: 'bg-hud-rust/20 text-hud-rust border border-hud-rust/30' },
  waiting_on_client: { label: 'Waiting on Client', className: 'bg-orange-500/20 text-orange-400 border border-orange-500/30' },
  resolved: { label: 'Resolved', className: 'bg-hud-emerald/20 text-hud-emerald border border-hud-emerald/30' },
  closed: { label: 'Closed', className: 'bg-hud-cream-mute/20 text-hud-cream-dim border border-hud-cream-mute/30' },
};

interface Props {
  status: SupportTicketStatus;
  size?: 'sm' | 'md';
}

export function SupportTicketAdminStatusBadge({ status, size = 'md' }: Props) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.new;
  const sizeClass = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-xs px-2 py-1';

  return (
    <span className={`inline-flex items-center rounded-full font-medium ${sizeClass} ${config.className}`}>
      {config.label}
    </span>
  );
}
