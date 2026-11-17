import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar,
  DollarSign,
  Loader2,
  ArrowRight,
  Inbox,
} from 'lucide-react';
import { useClientPortalV2 } from '../../../contexts/ClientPortalContextV2';
import { fetchMyProjects, type ClientPortalProject } from '../../../services/clientPortal';
import { getErrorMessage, logError } from '../../../lib/errors';

const PRIORITY_COLOR: Record<string, string> = {
  low: 'bg-hud-cream-mute/20 text-hud-cream-dim',
  medium: 'bg-hud-rust/20 text-hud-rust',
  high: 'bg-orange-500/20 text-orange-400',
  critical: 'bg-hud-plum/20 text-hud-plum',
};

export function ClientPortalDashboardPage() {
  const { state, sessionToken, contact } = useClientPortalV2();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ClientPortalProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== 'authenticated' || !sessionToken) return;
    let cancelled = false;
    setError(null);
    fetchMyProjects(sessionToken)
      .then((data) => { if (!cancelled) setProjects(data); })
      .catch((err) => {
        logError('ClientPortalDashboardPage.fetchMyProjects', err);
        if (!cancelled) setError(getErrorMessage(err, 'Failed to load your projects'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [state, sessionToken]);

  useEffect(() => {
    if (state !== 'authenticated') {
      navigate('/client-portal', { replace: true });
    }
  }, [state, navigate]);

  if (state !== 'authenticated') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Greeting */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">
          Welcome back{contact?.contactName ? `, ${contact.contactName}` : ''}
        </h1>
        <p className="text-sm text-hud-cream-dim">
          Here are your active projects. Click on a project to view details, submit change requests, or access documents.
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-hud-gold" />
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="text-center py-16">
          <h2 className="text-lg font-semibold text-white mb-1">Couldn't load your projects</h2>
          <p className="text-sm text-hud-cream-dim">{error}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && projects.length === 0 && (
        <div className="text-center py-16">
          <div className="w-16 h-16 bg-hud-bg-card rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Inbox size={28} className="text-hud-cream-mute" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-1">No projects yet</h2>
          <p className="text-sm text-hud-cream-dim">
            When your service provider creates a project for you, it will appear here.
          </p>
        </div>
      )}

      {/* Project grid */}
      {!loading && projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => navigate(`/client-portal/projects/${project.id}`)}
              className="text-left bg-hud-bg-mid border border-hud-bg-card rounded-xl p-5 hover:border-hud-gold/40 hover:bg-hud-bg-card/50 transition-all group"
            >
              {/* Stage badge */}
              {project.stage && (
                <span
                  className="inline-block px-2.5 py-0.5 text-xs font-medium rounded-full mb-3"
                  style={{
                    backgroundColor: `${project.stage.color ?? '#334155'}20`,
                    color: project.stage.color ?? '#94a3b8',
                  }}
                >
                  {project.stage.name}
                </span>
              )}

              {/* Name */}
              <h3 className="text-base font-semibold text-white mb-2 group-hover:text-hud-gold-soft transition-colors">
                {project.name}
              </h3>

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-hud-cream-dim mb-3">
                {project.start_date && (
                  <span className="flex items-center gap-1">
                    <Calendar size={12} />
                    {new Date(project.start_date).toLocaleDateString()}
                  </span>
                )}
                {project.budget_amount > 0 && (
                  <span className="flex items-center gap-1">
                    <DollarSign size={12} />
                    {project.budget_amount.toLocaleString()} {project.currency}
                  </span>
                )}
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PRIORITY_COLOR[project.priority] ?? PRIORITY_COLOR.medium}`}
                >
                  {project.priority}
                </span>
              </div>

              {/* Progress bar */}
              {project.progress_percent > 0 && (
                <div className="mt-auto">
                  <div className="flex items-center justify-between text-xs text-hud-cream-mute mb-1">
                    <span>Progress</span>
                    <span>{project.progress_percent}%</span>
                  </div>
                  <div className="h-1.5 bg-hud-bg-card rounded-full overflow-hidden">
                    <div
                      className="h-full bg-hud-gold rounded-full transition-all"
                      style={{ width: `${project.progress_percent}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Arrow hint */}
              <div className="flex justify-end mt-3">
                <ArrowRight size={16} className="text-hud-cream-mute group-hover:text-hud-gold-soft transition-colors" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
