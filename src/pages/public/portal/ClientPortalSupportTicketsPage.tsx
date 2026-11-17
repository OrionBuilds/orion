import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight,
  Plus,
  Search,
  LifeBuoy,
  Clock,
  Headphones,
} from 'lucide-react';
import { useClientPortal } from '../../../contexts/ClientPortalContext';
import { getPortalSupportTickets } from '../../../services/projectClientPortals';
import { SupportTicketStatusBadge } from '../../../components/portal/SupportTicketStatusBadge';
import { SubmitSupportTicketModal } from '../../../components/portal/SubmitSupportTicketModal';
import type { ProjectSupportTicket } from '../../../types';

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-hud-bg-dim',
  medium: 'bg-hud-rust',
  high: 'bg-hud-rust',
  critical: 'bg-hud-plum',
};

const CATEGORY_LABELS: Record<string, string> = {
  ai_automation: 'AI Automation',
  crm_pipeline: 'CRM / Pipeline',
  content_automation: 'Content Engine',
  integration_api: 'Integration / API',
  workflow_automation: 'Workflows',
  custom_software: 'Custom Software',
  data_analytics: 'Data / Analytics',
  other: 'Other',
};

const FILTER_TABS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'waiting_on_client', label: 'Waiting on You' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

const OPEN_STATUSES = ['new', 'in_review', 'in_progress'];

export function ClientPortalSupportTicketsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { portal } = useClientPortal();
  const navigate = useNavigate();

  const [tickets, setTickets] = useState<ProjectSupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);

  useEffect(() => {
    if (!portal) return;
    setLoading(true);
    getPortalSupportTickets(portal.project_id).then(setTickets).catch(console.error).finally(() => setLoading(false));
  }, [portal]);

  if (!portal) return null;

  const contact = portal.contact;
  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Client'
    : 'Client';

  const filtered = tickets.filter((t) => {
    const matchesFilter =
      !activeFilter ||
      (activeFilter === 'open' && OPEN_STATUSES.includes(t.status)) ||
      t.status === activeFilter;
    const matchesSearch = !search || t.title.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const waitingCount = tickets.filter((t) => t.status === 'waiting_on_client').length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-hud-cream-soft">Support Tickets</h2>
          <p className="text-sm text-hud-cream-mute mt-0.5">{tickets.length} total ticket{tickets.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowSubmitModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-hud-teal hover:bg-hud-teal text-hud-bg-deep text-sm font-semibold rounded-xl transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">New Ticket</span>
        </button>
      </div>

      {waitingCount > 0 && (
        <div className="bg-hud-rust/10 border border-hud-rust/30 rounded-xl px-4 py-3 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-hud-rust animate-pulse" />
          <p className="text-sm text-hud-rust font-medium">
            {waitingCount} ticket{waitingCount > 1 ? 's' : ''} waiting on your response
          </p>
          <button
            onClick={() => setActiveFilter('waiting_on_client')}
            className="ml-auto text-xs font-semibold text-hud-rust hover:text-hud-rust"
          >
            View
          </button>
        </div>
      )}

      <div className="bg-hud-bg-elev rounded-2xl border border-hud-line overflow-hidden">
        <div className="p-4 border-b border-hud-cream space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search support tickets..."
              className="w-full pl-9 pr-4 py-2 text-sm bg-hud-bg-card border border-hud-line rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-teal/30 focus:border-hud-teal text-hud-cream-soft placeholder-hud-cream-dim"
            />
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveFilter(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  activeFilter === tab.key
                    ? 'bg-hud-teal text-hud-bg-deep'
                    : 'bg-hud-bg-mid text-hud-cream-mute hover:bg-hud-bg-mid'
                }`}
              >
                {tab.label}
                {tab.key === 'waiting_on_client' && waitingCount > 0 && (
                  <span className="ml-1.5 bg-hud-rust text-hud-bg-deep rounded-full px-1.5 py-0.5 text-xs">
                    {waitingCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-teal" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <LifeBuoy className="w-8 h-8 text-hud-cream-soft mx-auto mb-2" />
            <p className="text-sm text-hud-cream-mute">
              {search || activeFilter ? 'No tickets match your filters' : 'No support tickets yet'}
            </p>
            {!search && !activeFilter && (
              <button
                onClick={() => setShowSubmitModal(true)}
                className="mt-3 text-sm text-hud-teal hover:text-hud-teal font-medium"
              >
                Submit your first ticket
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-hud-bg-elev">
            {filtered.map((ticket) => (
              <button
                key={ticket.id}
                onClick={() => navigate(`/client-portal/projects/${projectId}/support-tickets/${ticket.id}`)}
                className="w-full flex items-center gap-4 px-5 py-4 hover:bg-hud-bg-elev transition-colors text-left group"
              >
                <div className={`w-2.5 h-2.5 rounded-full flex-none mt-0.5 ${PRIORITY_DOT[ticket.priority] ?? 'bg-hud-bg-dim'}`} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-semibold text-hud-cream-soft">{ticket.title}</span>
                    <span className="text-xs text-hud-cream-dim">{CATEGORY_LABELS[ticket.service_category] ?? ticket.service_category}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-hud-cream-dim">
                    <span>{ticket.ticket_number}</span>
                    <span>{new Date(ticket.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    {ticket.severity_score >= 7 && (
                      <span className="text-hud-plum font-medium">Severity {ticket.severity_score}/10</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-none">
                  <SupportTicketStatusBadge status={ticket.status} />
                  <ChevronRight className="w-4 h-4 text-hud-cream-soft group-hover:text-hud-cream-mute transition-colors" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {showSubmitModal && (
        <SubmitSupportTicketModal
          projectId={portal.project_id}
          orgId={portal.org_id}
          contactName={contactName}
          contactEmail={contact?.email ?? undefined}
          contactPhone={contact?.phone ?? undefined}
          onSuccess={() => {
            setShowSubmitModal(false);
            getPortalSupportTickets(portal.project_id).then(setTickets);
          }}
          onClose={() => setShowSubmitModal(false)}
        />
      )}
    </div>
  );
}
