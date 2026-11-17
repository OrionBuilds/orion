import type { ProjectChangeRequestStatus } from '../../types';

const STATUS_CONFIG: Record<ProjectChangeRequestStatus, { label: string; className: string }> = {
  submitted: { label: 'Submitted', className: 'bg-blue-100 text-blue-700 border border-blue-200' },
  under_review: { label: 'Under Review', className: 'bg-hud-gold/15 text-hud-gold-deep border border-hud-gold/25' },
  needs_more_info: { label: 'Needs Info', className: 'bg-hud-rust/15 text-hud-rust border border-hud-rust/25' },
  quoted_awaiting_approval: { label: 'Awaiting Approval', className: 'bg-orange-100 text-orange-700 border border-orange-200' },
  approved: { label: 'Approved', className: 'bg-hud-emerald/15 text-hud-emerald border border-hud-emerald/25' },
  rejected: { label: 'Rejected', className: 'bg-hud-plum/15 text-hud-plum border border-hud-plum/25' },
  scheduled: { label: 'Scheduled', className: 'bg-blue-100 text-blue-600 border border-blue-200' },
  in_progress: { label: 'In Progress', className: 'bg-hud-gold/15 text-hud-gold-deep border border-hud-gold/25' },
  completed: { label: 'Completed', className: 'bg-hud-emerald/15 text-hud-emerald border border-hud-emerald/25' },
  cancelled: { label: 'Cancelled', className: 'bg-hud-cream text-hud-cream-mute border border-hud-cream-soft' },
};

interface Props {
  status: ProjectChangeRequestStatus;
  size?: 'sm' | 'md' | 'lg';
}

export function PortalStatusBadge({ status, size = 'md' }: Props) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.submitted;
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
