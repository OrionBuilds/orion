import { useNavigate } from 'react-router-dom';
import { Clock, AlertTriangle, User as UserIcon } from 'lucide-react';
import type { Project, ProjectStage } from '../../types';

interface Props {
  project: Project;
  stage?: ProjectStage;
  isDragging?: boolean;
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-hud-cream-mute',
  medium: 'bg-blue-500',
  high: 'bg-hud-rust',
  urgent: 'bg-hud-plum',
};

const RISK_COLORS: Record<string, string> = {
  low: 'bg-hud-emerald',
  medium: 'bg-hud-rust',
  high: 'bg-orange-500',
  critical: 'bg-hud-plum',
};

function getSlaStatus(project: Project, stage?: ProjectStage): 'ok' | 'warning' | 'breached' {
  if (!stage || stage.sla_days <= 0 || !project.stage_changed_at) return 'ok';
  const changed = new Date(project.stage_changed_at);
  const now = new Date();
  const daysInStage = Math.floor((now.getTime() - changed.getTime()) / (1000 * 60 * 60 * 24));
  if (daysInStage >= stage.sla_days) return 'breached';
  if (daysInStage >= stage.sla_days * 0.8) return 'warning';
  return 'ok';
}

function isOverdue(project: Project): boolean {
  if (project.status !== 'active' || !project.target_end_date) return false;
  return project.target_end_date < new Date().toISOString().split('T')[0];
}

export function ProjectCard({ project, stage, isDragging }: Props) {
  const navigate = useNavigate();
  const overdue = isOverdue(project);
  const slaStatus = getSlaStatus(project, stage);
  // BUG FIX (flagged): Contact has first_name/last_name, not `name` — this always showed 'Unknown'
  const contactName = (project.contact ? `${project.contact.first_name} ${project.contact.last_name}`.trim() : '') || 'Unknown';

  return (
    <div
      onClick={() => navigate(`/projects/${project.id}`)}
      className={`bg-hud-bg-card/80 border rounded-lg p-3 cursor-pointer hover:border-hud-cream-mute transition-all group ${
        overdue ? 'border-l-4 border-l-hud-plum border-hud-bg-elev' : 'border-hud-bg-elev'
      } ${isDragging ? 'opacity-50 scale-95' : ''}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h4 className="text-sm font-medium text-white leading-tight line-clamp-2 group-hover:text-hud-gold-soft transition-colors">
          {project.name}
        </h4>
        <div className="flex items-center gap-1 flex-shrink-0">
          <div className={`w-2 h-2 rounded-full ${PRIORITY_COLORS[project.priority]}`} title={`Priority: ${project.priority}`} />
          {project.risk_level !== 'low' && (
            <div className={`w-2 h-2 rounded-full ${RISK_COLORS[project.risk_level]}`} title={`Risk: ${project.risk_level}`} />
          )}
        </div>
      </div>

      <p className="text-xs text-hud-cream-dim mb-2.5 truncate">{contactName}</p>

      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 bg-hud-bg-elev rounded-full h-1.5 overflow-hidden">
          <div
            className="h-full bg-hud-gold rounded-full transition-all"
            style={{ width: `${project.progress_percent}%` }}
          />
        </div>
        <span className="text-xs text-hud-cream-mute tabular-nums">{project.progress_percent}%</span>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {overdue && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-hud-plum/20 text-hud-plum rounded">
              <AlertTriangle className="w-3 h-3" />
              Overdue
            </span>
          )}
          {slaStatus === 'breached' && !overdue && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-hud-plum/20 text-hud-plum rounded">
              <Clock className="w-3 h-3" />
              SLA
            </span>
          )}
          {slaStatus === 'warning' && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-hud-rust/20 text-hud-rust rounded">
              <Clock className="w-3 h-3" />
              SLA
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {project.assigned_user ? (
            <div className="w-6 h-6 rounded-full bg-hud-cream-mute flex items-center justify-center" title={project.assigned_user.name}>
              {project.assigned_user.avatar_url ? (
                <img src={project.assigned_user.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" />
              ) : (
                <span className="text-[10px] text-hud-cream-soft font-medium">
                  {project.assigned_user.name?.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                </span>
              )}
            </div>
          ) : (
            <div className="w-6 h-6 rounded-full bg-hud-bg-elev flex items-center justify-center">
              <UserIcon className="w-3 h-3 text-hud-cream-mute" />
            </div>
          )}
        </div>
      </div>

      {project.budget_amount > 0 && (
        <div className="mt-2 pt-2 border-t border-hud-bg-elev/50">
          <span className="text-xs text-hud-cream-mute">
            ${Number(project.budget_amount).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
