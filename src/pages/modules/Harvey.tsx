import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, ClipboardCheck, Loader2, MessageSquare, Pause, Play, RefreshCw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader } from '../../components/layouts';
import { Badge, EmptyNote, ErrorNote, Panel, StatusPill, Stat } from '../../components/agent-health/ui';
import {
  attentionItems, countByStage, eventTone, listCommands, listEvents, listPendingDrafts, listProspects,
  liveness, sendCommand, stageLabel, stageTone, getStatus,
  type HarveyCommand, type HarveyCommandName, type HarveyEvent, type HarveyProspect, type HarveyStatusRow, type PendingDraft,
} from '../../services/harvey';
import { reportBackgroundError } from '../../lib/errors';
import { applyFilters, listSearches, type HarveySearch, type ProspectFilters } from '../../services/harveyGrowth';
import { FunnelPanel } from '../../components/harvey/FunnelPanel';
import { LinkedInPanel } from '../../components/harvey/LinkedInPanel';
import { PipelineTools } from '../../components/harvey/PipelineTools';
import { SafetyPanel } from '../../components/harvey/SafetyPanel';

const REFRESH_MS = 30_000;
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'funnel', label: 'Funnel' },
  { id: 'replies', label: 'Replies' },
  { id: 'activity', label: 'Activity' },
];

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

/**
 * Harvey: the owner's personal-brand outbound agent. He runs on the owner's Linux box and reports here;
 * drafts are decided in Approvals (shared queue), questions go to his pinned thread in Conversations.
 * Controls here only queue a command: Harvey picks it up on his next poll (about a minute).
 */
export function Harvey() {
  const { user, hasPermission } = useAuth();
  const orgId = user?.organization_id;
  const canManage = hasPermission('harvey.manage');
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'overview';

  const [status, setStatus] = useState<HarveyStatusRow | null>(null);
  const [prospects, setProspects] = useState<HarveyProspect[]>([]);
  const [events, setEvents] = useState<HarveyEvent[]>([]);
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);
  const [commands, setCommands] = useState<HarveyCommand[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<ProspectFilters>({});
  const [activeSearchId, setActiveSearchId] = useState('');
  const [searches, setSearches] = useState<HarveySearch[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (quiet = false) => {
    if (!orgId) return;
    if (!quiet) setLoading(true);
    try {
      const [s, p, e, d, c, ss] = await Promise.all([
        getStatus(orgId), listProspects(orgId), listEvents(orgId, { limit: 200 }), listPendingDrafts(orgId), listCommands(orgId),
        listSearches(orgId).catch(() => [] as HarveySearch[]),   // before the growth migration is applied there are none
      ]);
      setStatus(s); setProspects(p); setEvents(e); setDrafts(d); setCommands(c); setSearches(ss);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };

  const run = async (command: HarveyCommandName) => {
    if (!orgId || !user) return;
    const s = status?.snapshot;
    if (command === 'resume' && s?.paused_automatically
      && !window.confirm(`HARVEY paused himself: ${s.paused_reason}\n\nResume anyway?`)) return;
    if (command === 'pause' && !window.confirm('Pause all sending? Nothing will go out until you resume.')) return;
    setBusy(true);
    try {
      await sendCommand(orgId, user.id, command);
      await load(true);
    } catch (err) {
      reportBackgroundError('harvey.command')(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lv = liveness(status, now);
  const snap = status?.snapshot ?? {};
  const attention = useMemo(() => attentionItems(status, drafts.length, now), [status, drafts.length, now]);
  const stages = useMemo(() => countByStage(prospects), [prospects]);
  const shownProspects = useMemo(() => applyFilters(prospects, filters), [prospects, filters]);
  const linkedinToSend = snap.linkedin?.mode === 'assist' ? (snap.linkedin.queue?.length ?? 0) : 0;
  const replies = events.filter((e) => e.kind === 'reply');
  const queuedCommand = commands.find((c) => c.status === 'queued' || c.status === 'claimed');

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        title="HARVEY"
        subtitle={status
          ? `${lv.reason} · ${snap.paused ? 'sending paused' : 'sending on'}${snap.quiet_hours ? ' · quiet hours' : ''} · ${drafts.length} draft${drafts.length === 1 ? '' : 's'} awaiting approval`
          : 'Personal-brand outbound agent'}
        icon={Bot}
        primaryAction={{ label: 'Refresh', icon: RefreshCw, onClick: () => void load() }}
      />

      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-hud-line-soft" aria-label="HARVEY sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-hud-gold text-hud-cream' : 'border-transparent text-hud-cream-dim hover:text-hud-cream'}`}>
            {t.label}{t.id === 'replies' && replies.length ? ` (${replies.length})` : ''}{t.id === 'linkedin' && linkedinToSend ? ` (${linkedinToSend})` : ''}
          </button>
        ))}
      </nav>

      <div className="mt-4 flex-1 space-y-4 overflow-y-auto pb-6">
        {loading && !status ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-hud-gold" /></div>
        ) : error && !status && !prospects.length ? (
          <ErrorNote message={error} />
        ) : (
          <>
            {error && <ErrorNote message={error} />}
            {notice && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-hud-emerald/30 bg-hud-emerald/10 px-3 py-2 text-sm text-hud-emerald" role="status">
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice(null)} className="text-xs text-hud-cream-dim hover:text-hud-cream">Dismiss</button>
              </div>)}

            {tab === 'overview' && (
              <>
                <Panel title="Needs your attention" icon={<ClipboardCheck size={14} />}
                  actions={<Link to="/automation/approvals" className="text-xs text-hud-gold hover:underline">Open Approvals</Link>}>
                  {attention.length === 0
                    ? <p className="text-sm text-hud-cream-dim">Nothing needs you right now.</p>
                    : <ul className="space-y-1.5 text-sm">{attention.map((a) => (
                      <li key={a.text} className="flex items-start gap-2">
                        <Badge tone={a.tone === 'bad' ? 'bad' : a.tone === 'warn' ? 'warn' : 'info'}>{a.tone === 'info' ? 'todo' : a.tone === 'bad' ? 'urgent' : 'check'}</Badge>
                        <span className="text-hud-cream-soft">{a.text}</span>
                      </li>))}</ul>}
                </Panel>

                <Panel title="Status" actions={<StatusPill level={lv.level} />}>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat label="Sending" value={snap.paused ? 'Paused' : 'On'} tone={snap.paused ? 'bad' : 'ok'}
                      hint={snap.email ? `${snap.email.provider}${snap.email.require_approval ? ' · approval required' : ''}` : undefined} />
                    <Stat label="Sent today" value={snap.email ? `${snap.email.sent_today}/${snap.email.daily_cap}` : '—'} />
                    <Stat label="Awaiting approval" value={drafts.length} tone={drafts.length ? 'warn' : 'default'} />
                    <Stat label="Approved, queued" value={snap.approved_waiting ?? 0} />
                    <Stat label="Open conversations" value={snap.open_conversations ?? 0} />
                    <Stat label="Prospects" value={prospects.length} />
                    <Stat label="Hunter searches left" value={snap.hunter_searches_left ?? '—'} hint="free tier, monthly" />
                    <Stat label="Quiet hours" value={snap.quiet_hours ? 'Now' : 'No'} hint={snap.quiet_window} />
                  </div>
                </Panel>

                <SafetyPanel limits={snap.safety} />

                <Panel title="Controls"
                  actions={<Link to="/conversations" className="inline-flex items-center gap-1 text-xs text-hud-gold hover:underline"><MessageSquare size={12} /> Talk to HARVEY</Link>}>
                  {canManage ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {snap.paused
                        ? <button type="button" disabled={busy || lv.level === 'offline'} onClick={() => void run('resume')}
                          className="inline-flex items-center gap-1.5 rounded-md border border-hud-emerald/40 px-3 py-1.5 text-sm text-hud-emerald hover:bg-hud-emerald/10 disabled:opacity-50"><Play size={14} /> Resume sending</button>
                        : <button type="button" disabled={busy || lv.level === 'offline'} onClick={() => void run('pause')}
                          className="inline-flex items-center gap-1.5 rounded-md border border-hud-plum/40 px-3 py-1.5 text-sm text-hud-plum hover:bg-hud-plum/10 disabled:opacity-50"><Pause size={14} /> Pause sending</button>}
                      <button type="button" disabled={busy || lv.level === 'offline'} onClick={() => void run('sync_now')}
                        className="inline-flex items-center gap-1.5 rounded-md border border-hud-line-soft px-3 py-1.5 text-sm text-hud-cream-dim hover:text-hud-cream disabled:opacity-50"><RefreshCw size={14} /> Full resync</button>
                      <span className="text-xs text-hud-cream-mute">
                        {queuedCommand ? `Waiting for HARVEY to pick up "${queuedCommand.command}"…`
                          : commands[0] ? `Last: ${commands[0].command} ${commands[0].status}${commands[0].result ? ` (${commands[0].result})` : ''}` : 'Commands reach HARVEY within about a minute.'}
                      </span>
                    </div>
                  ) : <p className="text-sm text-hud-cream-dim">Only the owner can control HARVEY.</p>}
                </Panel>

                <Panel title="Pipeline">
                  {stages.length === 0 ? <EmptyNote>No prospects yet.</EmptyNote> : (
                    <div className="flex flex-wrap gap-2">
                      {stages.map((s) => (
                        <button key={s.stage} type="button" onClick={() => { setActiveSearchId(''); setFilters({ stages: [s.stage] }); setTab('pipeline'); }}
                          className="rounded-lg border border-hud-line-soft px-3 py-1.5 text-sm hover:border-hud-gold">
                          <span className="font-hud-mono text-hud-cream">{s.n}</span> <span className="text-hud-cream-dim">{stageLabel(s.stage)}</span>
                        </button>))}
                    </div>)}
                </Panel>

                <Panel title="Latest activity">
                  <EventList events={events.slice(0, 8)} />
                </Panel>
              </>
            )}

            {tab === 'pipeline' && orgId && user && (
              <Panel title={`Prospects (${shownProspects.length})`}>
                <PipelineTools orgId={orgId} userId={user.id} canManage={canManage} prospects={prospects}
                  filters={filters} onFilters={setFilters} activeSearchId={activeSearchId} onActiveSearch={setActiveSearchId}
                  onSearches={setSearches} onNotice={(m) => { setNotice(m); void load(true); }} />
                <div className="mt-3">
                  {shownProspects.length === 0 ? <EmptyNote>No prospects match.</EmptyNote> : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left text-sm">
                        <thead className="text-[11px] uppercase tracking-wider text-hud-cream-mute">
                          <tr><th className="py-1.5 pr-3">Who</th><th className="pr-3">Company</th><th className="pr-3">Stage</th><th className="pr-3">Emails</th><th className="pr-3">Last sent</th><th>Next</th></tr>
                        </thead>
                        <tbody className="divide-y divide-hud-line-soft">
                          {shownProspects.map((p) => (
                            <tr key={p.prospect_id}>
                              <td className="py-2 pr-3"><div className="text-hud-cream">{p.name || '—'}</div><div className="text-xs text-hud-cream-mute">{p.title}</div></td>
                              <td className="pr-3 text-hud-cream-soft">{p.company}</td>
                              <td className="pr-3"><Badge tone={stageTone(p.stage)}>{stageLabel(p.stage)}</Badge></td>
                              <td className="pr-3 text-hud-cream-dim">{p.data.emails_sent ?? 0} sent{p.data.drafts_waiting ? ` · ${p.data.drafts_waiting} draft` : ''}</td>
                              <td className="pr-3 text-hud-cream-dim">{when(p.last_event_at)}</td>
                              <td className="text-hud-cream-dim">{when(p.next_step_at)}</td>
                            </tr>))}
                        </tbody>
                      </table>
                    </div>)}
                </div>
              </Panel>
            )}

            {tab === 'linkedin' && orgId && user && (
              <>
                <LinkedInPanel linkedin={snap.linkedin} orgId={orgId} userId={user.id} canManage={canManage} onChanged={() => void load(true)} />
                <SafetyPanel limits={(snap.safety ?? []).filter((l) => l.channel.startsWith('linkedin'))} />
              </>
            )}

            {tab === 'funnel' && orgId && <FunnelPanel orgId={orgId} prospects={prospects} searches={searches} />}

            {tab === 'replies' && (
              <Panel title={`Replies (${replies.length})`}>
                {replies.length === 0 ? <EmptyNote>No replies yet. When someone answers, it shows here and HARVEY texts you.</EmptyNote> : (
                  <ul className="space-y-3">
                    {replies.map((r) => (
                      <li key={r.id} className="rounded-lg border border-hud-line-soft p-3">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-hud-cream">{r.summary}</span>
                          <span className="flex items-center gap-2 text-xs text-hud-cream-mute">{r.data.intent && <Badge tone="info">{r.data.intent}</Badge>}{when(r.at)}</span>
                        </div>
                        {r.data.excerpt && <p className="mt-1.5 whitespace-pre-wrap text-sm text-hud-cream-soft">{r.data.excerpt}</p>}
                      </li>))}
                  </ul>)}
              </Panel>
            )}

            {tab === 'activity' && <Panel title="Activity"><EventList events={events} /></Panel>}
          </>
        )}
      </div>
    </div>
  );
}

function EventList({ events }: { events: HarveyEvent[] }) {
  if (events.length === 0) return <EmptyNote>Nothing yet.</EmptyNote>;
  return (
    <ul className="divide-y divide-hud-line-soft">
      {events.map((e) => (
        <li key={e.id} className="flex items-start justify-between gap-3 py-2 text-sm">
          <span className="flex items-start gap-2"><Badge tone={eventTone(e.kind)}>{e.kind.replace(/_/g, ' ')}</Badge><span className="text-hud-cream-soft">{e.summary}</span></span>
          <span className="shrink-0 text-xs text-hud-cream-mute">{when(e.at)}</span>
        </li>))}
    </ul>
  );
}

export default Harvey;
