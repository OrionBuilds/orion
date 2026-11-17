import type { SupportTicketStatus } from '../../types';

const STATUS_CONFIG: Record<SupportTicketStatus, { label: string; className: string }> = {
  new: { label: 'New', className: 'bg-blue-100 text-blue-700 border border-blue-200' },
  in_review: { label: 'In Review', className: 'bg-hud-gold/15 text-hud-gold-deep border border-hud-gold/25' },
  in_progress: { label: 'In Progress', className: 'bg-hud-rust/15 text-hud-rust border border-hud-rust/25' },
  waiting_on_client: { label: 'Waiting on You', className: 'bg-orange-100 text-orange-700 border border-orange-200' },
  resolved: { label: 'Resolved', className: 'bg-hud-emerald/15 text-hud-emerald border border-hud-emerald/25' },
  closed: { label: 'Closed', className: 'bg-hud-cream text-hud-cream-mute border border-hud-cream-soft' },
};

interface Props {
  status: SupportTicketStatus;
  size?: 'sm' | 'md' | 'lg';
}

export function SupportTicketStatusBadge({ status, size = 'md' }: Props) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.new;
  const sizeClass =
    size === 'sm' ? 'text-xs px-2 py-0.5' :
    size === 'lg' ? 'text-sm px-3 py-1 font-semibold' :
    'text-xs px-2.5 py-1';

  return (
    <span className={`inline-flex items-center rounded-full font-medium ${sizeClass} ${config.className}`}>
      {config.label}
    </span>
  );
}
