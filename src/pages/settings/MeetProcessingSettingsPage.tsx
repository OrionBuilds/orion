import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Video, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Badge } from '../../components/dashboard/Badge';
import { MeetAccessBanner } from '../../components/meetings/MeetAccessBanner';
import {
  getMeetSessionsByOrg,
  getMeetProcessingStats,
  reprocessMeetSession,
  type MeetSessionFilters,
} from '../../services/meetSessions';
import type { GoogleMeetSession, GoogleMeetSessionStatus } from '../../types';

const PAGE_SIZE = 20;

const STATUS_FILTERS: { label: string; value: GoogleMeetSessionStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Completed', value: 'completed' },
  { label: 'Detected', value: 'detected' },
  { label: 'Queued', value: 'queued' },
  { label: 'Processing', value: 'processing' },
  { label: 'Failed', value: 'failed' },
  { label: 'No artifacts', value: 'no_artifacts' },
];

function statusVariant(status: GoogleMeetSessionStatus): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  switch (status) {
    case 'completed': return 'success';
    case 'failed': return 'error';
    case 'no_artifacts': return 'neutral';
    default: return 'info'; // detected | queued | processing
  }
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  noArtifacts: number;
}

export function MeetProcessingSettingsPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const orgId = user?.organization_id || '';

  const [sessions, setSessions] = useState<GoogleMeetSession[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<GoogleMeetSessionStatus | 'all'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async () => {
    if (!orgId) return;
    setIsLoading(true);
    setError(null);
    try {
      const filters: MeetSessionFilters | undefined =
        statusFilter === 'all' ? undefined : { status: [statusFilter] };
      const [{ sessions: rows, total: count }, s] = await Promise.all([
        getMeetSessionsByOrg(orgId, filters, page, PAGE_SIZE),
        getMeetProcessingStats(orgId),
      ]);
      setSessions(rows);
      setTotal(count);
      setStats(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Google Meet sessions');
    } finally {
      setIsLoading(false);
    }
  }, [orgId, statusFilter, page]);

  useEffect(() => { load(); }, [load]);

  const handleReprocess = async (session: GoogleMeetSession) => {
    setReprocessingId(session.id);
    try {
      const { processed } = await reprocessMeetSession(session.id);
      if (processed > 0) {
        showToast('success', 'Reprocessed', 'The meeting was processed and its artifacts were refreshed.');
      } else {
        showToast('info', 'No artifacts found', 'The job ran but found no transcript or recording for this meeting.');
      }
      await load();
    } catch (e) {
      showToast('error', 'Reprocess failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setReprocessingId(null);
    }
  };

  const setFilter = (value: GoogleMeetSessionStatus | 'all') => {
    setStatusFilter(value);
    setPage(1);
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-hud-gold/10">
          <Video className="w-5 h-5 text-hud-gold-soft" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-hud-cream">Meeting Processing</h1>
          <p className="text-sm text-hud-cream-dim">
            Monitor the Google Meet pipeline and reprocess individual meetings on demand. Microsoft
            Teams meetings are processed automatically and appear on the Meetings page; use Import
            transcript there for anything else.
          </p>
        </div>
      </div>

      <MeetAccessBanner />

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Total', value: stats.total, cls: 'text-hud-cream' },
            { label: 'Completed', value: stats.completed, cls: 'text-hud-emerald' },
            { label: 'Pending', value: stats.pending, cls: 'text-hud-gold-soft' },
            { label: 'Failed', value: stats.failed, cls: 'text-hud-plum' },
            { label: 'No artifacts', value: stats.noArtifacts, cls: 'text-hud-cream-dim' },
          ].map((c) => (
            <div key={c.label} className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-4">
              <div className={`text-2xl font-semibold ${c.cls}`}>{c.value}</div>
              <div className="text-xs text-hud-cream-dim mt-1">{c.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              statusFilter === f.value
                ? 'bg-hud-gold/15 text-hud-gold-soft border-hud-gold/40'
                : 'bg-hud-bg-card/60 text-hud-cream-dim border-hud-bg-elev hover:bg-hud-bg-card'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <AlertTriangle className="w-8 h-8 text-hud-plum" />
            <p className="text-hud-cream-soft">{error}</p>
            <button onClick={load} className="mt-2 px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev">
              Retry
            </button>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <Video className="w-8 h-8 text-hud-cream-mute" />
            <p className="text-hud-cream-dim">No Meet sessions found for this filter.</p>
          </div>
        ) : (
          // Contained scroll: stats, filters and pagination stay put while the list scrolls.
          <div className="max-h-[60dvh] overflow-y-auto overscroll-contain divide-y divide-hud-bg-card">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-start gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-hud-cream">
                      {s.calendar_event_summary || 'Untitled meeting'}
                    </span>
                    <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-hud-cream-dim">
                    {s.event_start_time ? new Date(s.event_start_time).toLocaleString() : 'No date'}
                    {s.organizer_email ? ` · ${s.organizer_email}` : ''}
                    {s.retry_count > 0 ? ` · ${s.retry_count} retries` : ''}
                  </div>
                  {s.processing_error && (
                    <div className="mt-1 text-xs text-hud-plum/80 truncate" title={s.processing_error}>
                      {s.processing_error}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleReprocess(s)}
                  disabled={reprocessingId === s.id}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {reprocessingId === s.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  {reprocessingId === s.id ? 'Processing…' : 'Reprocess'}
                </button>
              </div>
            ))}
          </div>
        )}

        {!isLoading && !error && total > PAGE_SIZE && (
          <div className="flex items-center justify-between p-4 border-t border-hud-bg-card">
            <span className="text-xs text-hud-cream-dim">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-hud-cream-mute">
        Reprocessing resets a meeting and runs the pipeline immediately, bypassing the 90-day
        backfill window. Meetings that fail with a token error need the meeting owner to reconnect
        Google first.
      </p>
    </div>
  );
}
