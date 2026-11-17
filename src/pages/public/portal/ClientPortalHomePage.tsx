import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Calendar,
  Clock,
  DollarSign,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Plus,
  Mail,
  Phone,
  FileText,
  TrendingUp,
  Headphones,
  LifeBuoy,
  Rocket,
  ChevronDown,
} from 'lucide-react';
import { useClientPortal } from '../../../contexts/ClientPortalContext';
import { getPortalChangeRequests, getPortalStats, getPortalSupportTickets, getPortalTicketStats } from '../../../services/projectClientPortals';
import { portalListProjectActivity, type PortalActivityEvent } from '../../../services/clientPortal';
import { ReleaseApprovalsCard } from '../../../components/portal/ReleaseApprovalsCard';
import { ClientReviewsCard } from '../../../components/portal/ClientReviewsCard';
import { AiGovernanceHomeLink } from './ClientPortalAiGovernancePage';
import { UpdateSections } from '../../../components/portal/UpdateSections';
import { PortalStatusBadge } from '../../../components/portal/PortalStatusBadge';
import { SupportTicketStatusBadge } from '../../../components/portal/SupportTicketStatusBadge';
import { SubmitChangeRequestModal } from '../../../components/portal/SubmitChangeRequestModal';
import { SubmitSupportTicketModal } from '../../../components/portal/SubmitSupportTicketModal';
import type { ProjectChangeRequest, ProjectSupportTicket } from '../../../types';

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-hud-bg-dim',
  medium: 'bg-hud-rust',
  high: 'bg-hud-rust',
  critical: 'bg-hud-plum',
};

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  color: string;
}) {
  const colors: Record<string, string> = {
    blue: 'bg-hud-gold/10 text-hud-gold',
    amber: 'bg-hud-rust/10 text-hud-rust',
    emerald: 'bg-hud-emerald/10 text-hud-emerald',
    orange: 'bg-hud-rust/10 text-hud-rust',
  };
  return (
    <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-5 shadow-sm">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colors[color]}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="text-2xl font-bold text-hud-cream-soft">{value}</div>
      <div className="text-sm text-hud-cream-mute mt-0.5">{label}</div>
    </div>
  );
}

export function ClientPortalHomePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { portal, logEvent } = useClientPortal();
  const navigate = useNavigate();

  const [requests, setRequests] = useState<ProjectChangeRequest[]>([]);
  const [tickets, setTickets] = useState<ProjectSupportTicket[]>([]);
  const [activity, setActivity] = useState<PortalActivityEvent[]>([]);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [expandedActivity, setExpandedActivity] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showTicketModal, setShowTicketModal] = useState(false);

  useEffect(() => {
    if (!portal) return;
    logEvent('project_portal.viewed');
    Promise.all([
      getPortalChangeRequests(portal.project_id),
      getPortalSupportTickets(portal.project_id),
      // Timeline is additive — a failure here must not blank the whole page.
      portalListProjectActivity(portal.project_id, 200).catch(() => [] as PortalActivityEvent[]),
    ]).then(([reqs, tix, act]) => {
      setRequests(reqs);
      setTickets(tix);
      setActivity(act);
    }).catch(console.error).finally(() => setLoading(false));
  }, [portal]);

  if (!portal) return null;

  const project = portal.project;
  const org = portal.organization;
  const contact = portal.contact;

  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Client'
    : 'Client';

  const stats = getPortalStats(requests);
  const ticketStats = getPortalTicketStats(tickets);
  const recentRequests = requests.slice(0, 5);
  const recentTickets = tickets.slice(0, 5);

  const base = `/client-portal/projects/${projectId}`;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-hud-bg-elev rounded-2xl border border-hud-line p-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-lg font-bold text-hud-cream-soft">{project?.name}</h2>
              <p className="text-sm text-hud-cream-mute mt-0.5 capitalize">
                {project?.status?.replace(/_/g, ' ') ?? '—'}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {project?.status && (
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${
                  project.status === 'active' ? 'bg-hud-emerald/15 text-hud-emerald' :
                  project.status === 'completed' ? 'bg-hud-bg-mid text-hud-cream-mute' :
                  project.status === 'on_hold' ? 'bg-hud-rust/15 text-hud-rust' :
                  'bg-hud-gold/20 text-hud-gold'
                }`}>
                  {project.status.replace(/_/g, ' ')}
                </span>
              )}
            </div>
          </div>

          {project?.description && (
            <p className="text-sm text-hud-cream-mute leading-relaxed mb-5">{project.description}</p>
          )}

          <div className="grid grid-cols-2 gap-4">
            {project?.start_date && (
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="w-4 h-4 text-hud-cream-dim" />
                <div>
                  <div className="text-xs text-hud-cream-dim">Start Date</div>
                  <div className="text-white font-medium">
                    {new Date(project.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
              </div>
            )}
            {project?.target_end_date && (
              <div className="flex items-center gap-2 text-sm">
                <Clock className="w-4 h-4 text-hud-cream-dim" />
                <div>
                  <div className="text-xs text-hud-cream-dim">Est. Completion</div>
                  <div className="text-white font-medium">
                    {new Date(project.target_end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
              </div>
            )}
            {project?.updated_at && (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-hud-cream-dim" />
                <div>
                  <div className="text-xs text-hud-cream-dim">Last Updated</div>
                  <div className="text-white font-medium">
                    {new Date(project.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="bg-hud-bg-elev rounded-2xl border border-hud-line p-6 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white mb-3">Project Support</h3>
            <p className="text-sm text-hud-cream-mute mb-4">Have a question or need assistance with your project?</p>
            <div className="space-y-2">
              {org?.email && (
                <a href={`mailto:${org.email}`} className="flex items-center gap-2.5 text-sm text-hud-cream-mute hover:text-hud-gold transition-colors">
                  <Mail className="w-4 h-4 text-hud-cream-dim" />
                  {org.email}
                </a>
              )}
              {org?.phone && (
                <a href={`tel:${org.phone}`} className="flex items-center gap-2.5 text-sm text-hud-cream-mute hover:text-hud-gold transition-colors">
                  <Phone className="w-4 h-4 text-hud-cream-dim" />
                  {org.phone}
                </a>
              )}
            </div>
          </div>
          <div className="mt-5 space-y-2">
            <button
              onClick={() => setShowSubmitModal(true)}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep text-sm font-semibold rounded-xl transition-colors"
            >
              <Plus className="w-4 h-4" />
              Submit Change Request
            </button>
            <button
              onClick={() => setShowTicketModal(true)}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-hud-teal hover:bg-hud-teal text-hud-bg-deep text-sm font-semibold rounded-xl transition-colors"
            >
              <Headphones className="w-4 h-4" />
              Support Ticket
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard icon={FileText} label="Open Requests" value={loading ? '—' : stats.open} color="blue" />
        <StatCard icon={AlertCircle} label="Awaiting Approval" value={loading ? '—' : stats.awaitingApproval} color="orange" />
        <StatCard icon={CheckCircle2} label="Completed" value={loading ? '—' : stats.completed} color="emerald" />
        <StatCard
          icon={TrendingUp}
          label="Approved Value"
          value={loading ? '—' : `$${stats.totalApprovedValue.toLocaleString()}`}
          color="amber"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard icon={LifeBuoy} label="Open Tickets" value={loading ? '—' : ticketStats.open} color="blue" />
        <StatCard icon={Clock} label="Waiting on You" value={loading ? '—' : ticketStats.waitingOnClient} color="orange" />
        <StatCard icon={CheckCircle2} label="Resolved Tickets" value={loading ? '—' : ticketStats.resolved} color="emerald" />
      </div>

      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-cream">
          <h3 className="text-sm font-semibold text-hud-cream-soft">Recent Change Requests</h3>
          <button
            onClick={() => navigate(`${base}/change-requests`)}
            className="text-xs text-hud-gold hover:text-hud-gold-soft font-medium flex items-center gap-1"
          >
            View all
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold" />
          </div>
        ) : recentRequests.length === 0 ? (
          <div className="text-center py-12">
            <FileText className="w-8 h-8 text-hud-cream-soft mx-auto mb-2" />
            <p className="text-sm text-hud-cream-mute">No change requests yet</p>
            <button
              onClick={() => setShowSubmitModal(true)}
              className="mt-3 text-sm text-hud-gold hover:text-hud-gold-soft font-medium"
            >
              Submit your first request
            </button>
          </div>
        ) : (
          <div className="divide-y divide-hud-bg-elev">
            {recentRequests.map((req) => (
              <button
                key={req.id}
                onClick={() => navigate(`${base}/change-requests/${req.id}`)}
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-hud-bg-elev transition-colors text-left group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-2 h-2 rounded-full flex-none ${PRIORITY_DOT[req.priority] ?? 'bg-hud-bg-dim'}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-hud-cream-soft truncate">{req.title}</div>
                    <div className="text-xs text-hud-cream-dim mt-0.5">
                      {new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-none ml-4">
                  <PortalStatusBadge status={req.status} size="sm" />
                  <ChevronRight className="w-4 h-4 text-hud-cream-soft group-hover:text-hud-cream-mute transition-colors" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-cream">
          <h3 className="text-sm font-semibold text-hud-cream-soft">Recent Support Tickets</h3>
          <button
            onClick={() => navigate(`${base}/support-tickets`)}
            className="text-xs text-hud-teal hover:text-hud-teal font-medium flex items-center gap-1"
          >
            View all
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-teal" />
          </div>
        ) : recentTickets.length === 0 ? (
          <div className="text-center py-12">
            <LifeBuoy className="w-8 h-8 text-hud-cream-soft mx-auto mb-2" />
            <p className="text-sm text-hud-cream-mute">No support tickets yet</p>
            <button
              onClick={() => setShowTicketModal(true)}
              className="mt-3 text-sm text-hud-teal hover:text-hud-teal font-medium"
            >
              Submit your first ticket
            </button>
          </div>
        ) : (
          <div className="divide-y divide-hud-bg-elev">
            {recentTickets.map((ticket) => (
              <button
                key={ticket.id}
                onClick={() => navigate(`${base}/support-tickets/${ticket.id}`)}
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-hud-bg-elev transition-colors text-left group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-2 h-2 rounded-full flex-none ${PRIORITY_DOT[ticket.priority] ?? 'bg-hud-bg-dim'}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-hud-cream-soft truncate">{ticket.title}</div>
                    <div className="text-xs text-hud-cream-dim mt-0.5">
                      {ticket.ticket_number} &middot; {new Date(ticket.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-none ml-4">
                  <SupportTicketStatusBadge status={ticket.status} size="sm" />
                  <ChevronRight className="w-4 h-4 text-hud-cream-soft group-hover:text-hud-cream-mute transition-colors" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {projectId && <ClientReviewsCard projectId={projectId} />}
      {projectId && <AiGovernanceHomeLink projectId={projectId} />}

      <ReleaseApprovalsCard />

      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-cream">
          <h3 className="text-sm font-semibold text-hud-cream-soft">Project Updates</h3>
          {activity.length > 12 && (
            <button
              onClick={() => setShowAllActivity((v) => !v)}
              className="text-xs text-hud-gold hover:text-hud-gold-soft font-medium flex items-center gap-1"
            >
              {showAllActivity ? 'Show recent' : `Show all ${activity.length}`}
              <ChevronRight className={`w-3 h-3 transition-transform ${showAllActivity ? 'rotate-90' : ''}`} />
            </button>
          )}
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold" />
          </div>
        ) : activity.length === 0 ? (
          <div className="text-center py-12">
            <Clock className="w-8 h-8 text-hud-cream-soft mx-auto mb-2" />
            <p className="text-sm text-hud-cream-mute">No updates logged yet</p>
          </div>
        ) : (
          <div className="px-6 py-4">
            <ol className="relative border-l border-hud-line ml-2 space-y-4">
              {(showAllActivity ? activity : activity.slice(0, 12)).map((ev) => {
                const Icon =
                  ev.event_type === 'milestone'
                    ? Rocket
                    : ev.event_type === 'task_completed' || ev.event_type === 'client_request_completed'
                      ? CheckCircle2
                      : ev.event_type === 'client_request_submitted' || ev.event_type === 'change_request_submitted'
                        ? FileText
                        : ev.event_type === 'stage_changed' || ev.event_type === 'status_changed'
                          ? TrendingUp
                          : Calendar;
                const iconColor =
                  ev.event_type === 'milestone'
                    ? 'text-hud-gold'
                    : ev.event_type === 'task_completed' || ev.event_type === 'client_request_completed'
                      ? 'text-hud-emerald'
                      : ev.event_type === 'stage_changed' || ev.event_type === 'status_changed'
                        ? 'text-hud-gold'
                        : 'text-hud-cream-dim';
                const headline = ev.title || ev.summary;
                const isExpanded = expandedActivity.has(ev.id);
                return (
                  <li key={ev.id} className="ml-5">
                    <span className="absolute -left-2.5 flex items-center justify-center w-5 h-5 rounded-full bg-hud-bg-mid border border-hud-line">
                      <Icon className={`w-3 h-3 ${iconColor}`} />
                    </span>
                    {ev.detail || ev.sections ? (
                      <button
                        onClick={() =>
                          setExpandedActivity((prev) => {
                            const next = new Set(prev);
                            if (next.has(ev.id)) next.delete(ev.id);
                            else next.add(ev.id);
                            return next;
                          })
                        }
                        className="w-full text-left group"
                      >
                        <p className="text-sm text-hud-cream-soft leading-snug flex items-start gap-1.5">
                          <span className="flex-1">{headline}</span>
                          {ev.is_live && (
                            <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-hud-emerald/15 text-hud-emerald">
                              Live
                            </span>
                          )}
                          <ChevronDown
                            className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-hud-cream-dim group-hover:text-hud-gold transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          />
                        </p>
                        {isExpanded && (
                          ev.sections ? (
                            <UpdateSections sections={ev.sections} />
                          ) : (
                            <p className="text-xs text-hud-cream-mute leading-relaxed mt-1.5 pr-5 whitespace-pre-line">
                              {ev.detail}
                            </p>
                          )
                        )}
                      </button>
                    ) : (
                      <p className="text-sm text-hud-cream-soft leading-snug">{headline}</p>
                    )}
                    <p className="text-xs text-hud-cream-dim mt-0.5">
                      {new Date(ev.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      {showSubmitModal && portal && (
        <SubmitChangeRequestModal
          projectId={portal.project_id}
          orgId={portal.org_id}
          contactName={contactName}
          contactEmail={contact?.email ?? undefined}
          onSuccess={() => {
            setShowSubmitModal(false);
            getPortalChangeRequests(portal.project_id).then(setRequests);
          }}
          onClose={() => setShowSubmitModal(false)}
        />
      )}

      {showTicketModal && portal && (
        <SubmitSupportTicketModal
          projectId={portal.project_id}
          orgId={portal.org_id}
          contactName={contactName}
          contactEmail={contact?.email ?? undefined}
          contactPhone={contact?.phone ?? undefined}
          onSuccess={() => {
            setShowTicketModal(false);
            getPortalSupportTickets(portal.project_id).then(setTickets);
          }}
          onClose={() => setShowTicketModal(false)}
        />
      )}
    </div>
  );
}
