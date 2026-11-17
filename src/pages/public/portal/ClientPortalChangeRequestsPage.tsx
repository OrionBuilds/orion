import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight,
  Plus,
  Search,
  FileText,
  DollarSign,
  Clock,
} from 'lucide-react';
import { useClientPortal } from '../../../contexts/ClientPortalContext';
import { getPortalChangeRequests } from '../../../services/projectClientPortals';
import { PortalStatusBadge } from '../../../components/portal/PortalStatusBadge';
import { SubmitChangeRequestModal } from '../../../components/portal/SubmitChangeRequestModal';
import type { ProjectChangeRequest } from '../../../types';

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-hud-bg-dim',
  medium: 'bg-hud-rust',
  high: 'bg-hud-rust',
  critical: 'bg-hud-plum',
};

const TYPE_LABELS: Record<string, string> = {
  scope: 'Scope',
  timeline: 'Timeline',
  design: 'Design',
  feature: 'Feature',
  bugfix: 'Bug Fix',
  support: 'Support',
  other: 'Other',
};

const FILTER_TABS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'quoted_awaiting_approval', label: 'Awaiting Approval' },
  { key: 'completed', label: 'Completed' },
  { key: 'rejected', label: 'Rejected' },
];

const OPEN_STATUSES = ['submitted', 'under_review', 'needs_more_info', 'scheduled', 'in_progress'];

export function ClientPortalChangeRequestsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { portal } = useClientPortal();
  const navigate = useNavigate();

  const [requests, setRequests] = useState<ProjectChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);

  useEffect(() => {
    if (!portal) return;
    setLoading(true);
    getPortalChangeRequests(portal.project_id).then(setRequests).catch(console.error).finally(() => setLoading(false));
  }, [portal]);

  if (!portal) return null;

  const contact = portal.contact;
  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Client'
    : 'Client';

  const filtered = requests.filter((req) => {
    const matchesFilter =
      !activeFilter ||
      (activeFilter === 'open' && OPEN_STATUSES.includes(req.status)) ||
      req.status === activeFilter;
    const matchesSearch = !search || req.title.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const awaitingCount = requests.filter((r) => r.status === 'quoted_awaiting_approval').length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-hud-cream-soft">Change Requests</h2>
          <p className="text-sm text-hud-cream-mute mt-0.5">{requests.length} total request{requests.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowSubmitModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep text-sm font-semibold rounded-xl transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">New Request</span>
        </button>
      </div>

      {awaitingCount > 0 && (
        <div className="bg-hud-rust/10 border border-hud-rust/30 rounded-xl px-4 py-3 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-hud-rust animate-pulse" />
          <p className="text-sm text-hud-rust font-medium">
            {awaitingCount} change request{awaitingCount > 1 ? 's' : ''} awaiting your approval
          </p>
          <button
            onClick={() => setActiveFilter('quoted_awaiting_approval')}
            className="ml-auto text-xs font-semibold text-hud-rust hover:text-hud-rust"
          >
            Review
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
              placeholder="Search change requests..."
              className="w-full pl-9 pr-4 py-2 text-sm bg-hud-bg-card border border-hud-line rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-gold/30 focus:border-hud-gold text-hud-cream-soft placeholder-hud-cream-dim"
            />
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveFilter(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  activeFilter === tab.key
                    ? 'bg-hud-gold-deep text-white'
                    : 'bg-hud-bg-mid text-hud-cream-mute hover:bg-hud-bg-mid'
                }`}
              >
                {tab.label}
                {tab.key === 'quoted_awaiting_approval' && awaitingCount > 0 && (
                  <span className="ml-1.5 bg-hud-rust text-hud-bg-deep rounded-full px-1.5 py-0.5 text-xs">
                    {awaitingCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <FileText className="w-8 h-8 text-hud-cream-soft mx-auto mb-2" />
            <p className="text-sm text-hud-cream-mute">
              {search || activeFilter ? 'No requests match your filters' : 'No change requests yet'}
            </p>
            {!search && !activeFilter && (
              <button
                onClick={() => setShowSubmitModal(true)}
                className="mt-3 text-sm text-hud-gold hover:text-hud-gold-soft font-medium"
              >
                Submit your first request
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-hud-bg-elev">
            {filtered.map((req) => (
              <button
                key={req.id}
                onClick={() => navigate(`/client-portal/projects/${projectId}/change-requests/${req.id}`)}
                className="w-full flex items-center gap-4 px-5 py-4 hover:bg-hud-bg-elev transition-colors text-left group"
              >
                <div className={`w-2.5 h-2.5 rounded-full flex-none mt-0.5 ${PRIORITY_DOT[req.priority] ?? 'bg-hud-bg-dim'}`} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-semibold text-hud-cream-soft">{req.title}</span>
                    <span className="text-xs text-hud-cream-dim">{TYPE_LABELS[req.request_type] ?? req.request_type}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-hud-cream-dim">
                    <span>{new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    {req.cost_impact_visible_to_client && req.cost_impact > 0 && (
                      <span className="flex items-center gap-1">
                        <DollarSign className="w-3 h-3" />
                        +${Number(req.cost_impact).toLocaleString()}
                      </span>
                    )}
                    {req.timeline_impact_visible_to_client && req.timeline_impact_days > 0 && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        +{req.timeline_impact_days}d
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-none">
                  <PortalStatusBadge status={req.status} />
                  <ChevronRight className="w-4 h-4 text-hud-cream-soft group-hover:text-hud-cream-mute transition-colors" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {showSubmitModal && (
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
    </div>
  );
}
