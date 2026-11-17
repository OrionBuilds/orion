import type { ProjectChangeRequestStatus } from '../../types';

const STATUS_CONFIG: Record<
  ProjectChangeRequestStatus,
  { label: string; className: string }
> = {
  submitted: {
    label: 'Submitted',
    className: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  },
  under_review: {
    label: 'Under Review',
    className: 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/30',
  },
  needs_more_info: {
    label: 'Needs Info',
    className: 'bg-hud-rust/20 text-hud-rust border border-hud-rust/30',
  },
  quoted_awaiting_approval: {
    label: 'Awaiting Approval',
    className: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  },
  approved: {
    label: 'Approved',
    className: 'bg-hud-emerald/20 text-hud-emerald border border-hud-emerald/30',
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-hud-plum/20 text-hud-plum border border-hud-plum/30',
  },
  scheduled: {
    label: 'Scheduled',
    className: 'bg-blue-500/20 text-blue-300 border border-blue-400/30',
  },
  in_progress: {
    label: 'In Progress',
    className: 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold-soft/30',
  },
  completed: {
    label: 'Completed',
    className: 'bg-hud-emerald/20 text-hud-emerald/40 border border-hud-emerald/30',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-hud-cream-mute/20 text-hud-cream-dim border border-hud-cream-mute/30',
  },
};

interface Props {
  status: ProjectChangeRequestStatus;
  size?: 'sm' | 'md';
}

export function ChangeRequestStatusBadge({ status, size = 'md' }: Props) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.submitted;
  const sizeClass = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-xs px-2 py-1';

  return (
    <span className={`inline-flex items-center rounded-full font-medium ${sizeClass} ${config.className}`}>
      {config.label}
    </span>
  );
}
