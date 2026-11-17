import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Bot, CalendarDays, Check, ChevronRight, ClipboardCheck, HelpCircle, ListChecks, Loader2, MailQuestion, MessageSquare, Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { usePendingApprovalCount } from '../../hooks/usePendingApprovalCount';
import { useUnreadCount } from '../../hooks/useUnreadCount';
import { getApprovalQueue, type ApprovalQueueItem } from '../../services/workflowApprovals';
import { listAgentQuestions, listStoppedRequests, stoppedByAgent, type AgentQuestion } from '../../services/agentRequests';
import { listSenderSuggestions, resolveSenderSuggestion, suggestionText, type SenderSuggestion } from '../../services/senderSuggestions';
import { getAgentThreadPulse, getPinnedAgentThreads, matchPinnedAgent, type AgentThreadPulse } from '../../services/agentThreads';
import { getMyUpcomingAppointments } from '../../services/dashboard';
import { getMyTasks, updateTaskStatus, type UnifiedTask, type UnifiedTaskStatus } from '../../services/tasksHub';
import { ago, getOverview, type OverviewAgent } from '../../services/agentOps';
import { getStatus as getHarveyStatus, type HarveyStatusRow } from '../../services/harvey';
import {
  agentLine, harveyLine, nextUpNote, nextUpRows, pickDayTasks, taskDueLabel, threadAgentLine,
  type AgentLine, type NextUpRow, type Tone,
} from './myDayData';

const REFRESH_MS = 2 * 60 * 1000;
const NEXT_UP_MAX = 5;
const TASKS_MAX = 6;

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: string })?.message) || 'unknown error';

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };
const settle = <T,>(r: PromiseSettledResult<T>): Settled<T> =>
  r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: errText(r.reason) };

/**
 * One card's data: loads on mount and when `key` changes, again every two minutes while the tab is
 * visible and when it becomes visible. Each card owns its own, so one failing never blanks another.
 */
function useCard<T>(load: (() => Promise<T>) | null, key: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!load });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) return;
    const mine = ++seq.current;
    try {
      const data = await fn();
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (mine === seq.current) setState({ data: null, error: errText(e), loading: false });
    }
  }, []);

  useEffect(() => {
    reload();
    const tick = () => { if (document.visibilityState === 'visible') reload(); };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload, key]);

  return { ...state, reload };
}

const linkRow = 'flex items-center gap-3 min-h-[44px] -mx-2 px-2 py-1.5 rounded-lg hover:bg-hud-bg-elev/60 active:bg-hud-bg-elev touch-manipulation';
const TONE_DOT: Record<Tone, string> = { ok: 'bg-hud-emerald', warn: 'bg-hud-rust', bad: 'bg-hud-plum', muted: 'bg-hud-cream-mute' };

function Card({ title, icon: Icon, to, linkLabel, testId, children }: {
  title: string; icon: LucideIcon; to?: string; linkLabel?: string; testId: string; children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hud-bg-elev bg-hud-bg-card px-4 pt-1 pb-3" data-testid={testId} aria-label={title}>
      <div className="flex items-center justify-between gap-3 min-h-[44px]">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Icon className="w-4 h-4 text-hud-gold-soft" />
          {title}
        </h3>
        {to && linkLabel && (
          <Link to={to} className="inline-flex items-center gap-0.5 min-h-[44px] pl-3 text-xs font-medium text-hud-gold-soft touch-manipulation">
            {linkLabel}
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="space-y-3 py-2" aria-hidden>
    {Array.from({ length: rows }, (_, i) => <div key={i} className="h-4 rounded bg-hud-bg-elev animate-pulse" style={{ width: `${85 - i * 15}%` }} />)}
  </div>
);
const Problem = ({ children }: { children: ReactNode }) => <p className="py-1.5 text-sm text-hud-plum" role="alert">{children}</p>;
const Quiet = ({ children }: { children: ReactNode }) => <p className="py-1.5 text-sm text-hud-cream-dim">{children}</p>;
const Count = ({ n }: { n: number }) => (
  <span className="shrink-0 min-w-[1.5rem] rounded-full bg-hud-gold px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums text-hud-bg-deep">{n > 99 ? '99+' : n}</span>
);

// ── Needs you ────────────────────────────────────────────────────────────────────────────────

function approvalTitle(item: ApprovalQueueItem): string {
  const what = item.title || item.description || item.action_type.replace(/_/g, ' ');
  const who = item.agent_slug || item.agent_run?.agent?.name;
  return who ? `${who.toUpperCase()}: ${what}` : what;
}

interface NeedsYouData {
  approvals: Settled<{ data: ApprovalQueueItem[]; count: number }> | null;
  questions: Settled<{ data: AgentQuestion[]; count: number }>;
  /** Senders who look like a contact writing from an address we don't have. Null = may not edit contacts. */
  senders: Settled<SenderSuggestion[]> | null;
  /** Per agent: requests it could not finish, which only the owner can retry or dismiss. */
  stopped: Settled<Map<string, number>>;
  agentNames: Map<string, string>;
}

function NeedsYouCard({ orgId }: { orgId: string }) {
  const { hasPermission, isFeatureEnabled } = useAuth();
  const canApprovals = hasPermission('automation.view') && isFeatureEnabled('automation');
  const canConversations = hasPermission('conversations.view') && isFeatureEnabled('conversations');
  const canClara = hasPermission('personal_assistant.view');
  const canContacts = hasPermission('contacts.edit');
  const canAgents = hasPermission('agent_tasks.view') && isFeatureEnabled('agent_tasks');
  const { showToast } = useToast();
  const [resolving, setResolving] = useState<string | null>(null);
  const { count: liveApprovals } = usePendingApprovalCount(canApprovals);
  const { unreadCount } = useUnreadCount();

  const card = useCard<NeedsYouData>(async () => {
    const [approvals, questions, threads, senders, stopped] = await Promise.allSettled([
      canApprovals ? getApprovalQueue(orgId, { status: ['pending_approval'] }, 1, 3) : Promise.resolve(null),
      listAgentQuestions(orgId, 3),
      getPinnedAgentThreads(),
      canContacts ? listSenderSuggestions(orgId, 3) : Promise.resolve(null),
      listStoppedRequests(orgId).then(stoppedByAgent),
    ]);
    const agentNames = new Map<string, string>();
    if (threads.status === 'fulfilled') for (const t of threads.value) agentNames.set(t.agent_user_id, t.name);
    const a = settle(approvals);
    const sd = settle(senders);
    return {
      approvals: a.ok ? (a.value ? { ok: true, value: a.value } : null) : a, questions: settle(questions),
      senders: sd.ok ? (sd.value ? { ok: true, value: sd.value } : null) : sd, stopped: settle(stopped), agentNames,
    };
    // liveApprovals in the key: reload the titles as soon as the live count moves.
  }, `${orgId}:${canApprovals}:${canContacts}:${liveApprovals}`);

  const resolveSender = async (s: SenderSuggestion, accept: boolean) => {
    if (resolving) return;
    setResolving(s.id);
    try {
      await resolveSenderSuggestion(s.id, accept);
      if (accept) showToast('success', `Added to ${s.contact_name || 'the contact'}`, `Mail from ${s.email} is being pulled in and will be handled from now on.`);
      await card.reload();
    } catch (e) {
      showToast('error', accept ? "Couldn't add the address" : "Couldn't dismiss it", `${s.email}: ${errText(e)}`);
    } finally {
      setResolving(null);
    }
  };

  const data = card.data;
  const approvalCount = data?.approvals?.ok ? data.approvals.value.count : 0;
  const questionCount = data?.questions.ok ? data.questions.value.count : 0;
  const unread = canConversations ? unreadCount : 0;
  const threadHref = (agentUserId: string) =>
    canConversations ? `/conversations?agent=${agentUserId}` : canClara ? `/clara?agent=${agentUserId}` : null;
  const senders = data?.senders?.ok ? data.senders.value : [];
  const stopped = data?.stopped.ok ? [...data.stopped.value.entries()] : [];
  const clear = !!data && approvalCount === 0 && questionCount === 0 && unread === 0 && senders.length === 0 && stopped.length === 0
    && data.questions.ok && data.stopped.ok && (!data.approvals || data.approvals.ok) && (!data.senders || data.senders.ok);

  return (
    <Card title="Needs you" icon={ClipboardCheck} testId="myday-needs-you">
      {card.loading && <Skeleton />}
      {card.error && <Problem>Couldn't load what needs you: {card.error}</Problem>}
      {data && (
        <div className="space-y-1">
          {data.approvals && !data.approvals.ok && <Problem>Couldn't load approvals: {data.approvals.error}</Problem>}
          {data.approvals?.ok && approvalCount > 0 && (
            <Link to="/automation/approvals" className={`${linkRow} items-start`} data-testid="myday-approvals">
              <ClipboardCheck className="mt-0.5 w-4 h-4 shrink-0 text-hud-gold-soft" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-white">
                  {approvalCount} approval{approvalCount === 1 ? '' : 's'} waiting
                </span>
                {data.approvals.value.data.map((item) => (
                  <span key={item.id} className="block truncate text-xs text-hud-cream-dim">{approvalTitle(item)}</span>
                ))}
                {approvalCount > data.approvals.value.data.length && (
                  <span className="block text-xs text-hud-cream-mute">+{approvalCount - data.approvals.value.data.length} more</span>
                )}
              </span>
              <Count n={approvalCount} />
            </Link>
          )}

          {!data.questions.ok && <Problem>Couldn't load agent questions: {data.questions.error}</Problem>}
          {data.questions.ok && data.questions.value.data.map((q) => {
            const href = threadHref(q.to_user_id);
            const body = (
              <>
                <HelpCircle className="w-4 h-4 shrink-0 text-hud-teal" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white line-clamp-2">{q.result_summary || q.title || 'Question'}</span>
                  <span className="block truncate text-xs text-hud-cream-dim">
                    {data.agentNames.get(q.to_user_id) ?? 'An agent'} asked {ago(q.updated_at)}{q.result_summary && q.title ? ` · ${q.title}` : ''}
                  </span>
                </span>
                {href && <ChevronRight className="w-4 h-4 shrink-0 text-hud-cream-mute" />}
              </>
            );
            return href
              ? <Link key={q.id} to={href} className={linkRow}>{body}</Link>
              : <div key={q.id} className={linkRow}>{body}</div>;
          })}
          {data.questions.ok && questionCount > data.questions.value.data.length && (
            <p className="py-1 text-xs text-hud-cream-mute">+{questionCount - data.questions.value.data.length} more agent questions</p>
          )}

          {!data.stopped.ok && <Problem>Couldn't check for requests the agents could not finish: {data.stopped.error}</Problem>}
          {stopped.map(([agentId, n]) => {
            const body = (
              <>
                <AlertTriangle className="w-4 h-4 shrink-0 text-hud-rust" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white">
                    {data.agentNames.get(agentId) ?? 'An agent'} couldn't finish {n} request{n === 1 ? '' : 's'}
                  </span>
                  <span className="block text-xs text-hud-cream-dim">{n === 1 ? 'It stays' : 'They stay'} stopped until you retry or dismiss {n === 1 ? 'it' : 'them'}.</span>
                </span>
                {canAgents ? <ChevronRight className="w-4 h-4 shrink-0 text-hud-cream-mute" /> : <Count n={n} />}
              </>
            );
            return canAgents
              ? <Link key={agentId} to={`/agent-health?tab=${agentId}`} className={linkRow} data-testid="myday-stopped">{body}</Link>
              : <div key={agentId} className={linkRow} data-testid="myday-stopped">{body}</div>;
          })}

          {data.senders && !data.senders.ok && <Problem>Couldn't check for mail from unknown addresses: {data.senders.error}</Problem>}
          {senders.map((s) => {
            const text = suggestionText(s);
            const busy = resolving === s.id;
            return (
              <div key={s.id} className="py-1.5" data-testid="myday-sender-suggestion">
                <div className="flex items-start gap-3">
                  <MailQuestion className="mt-0.5 w-4 h-4 shrink-0 text-hud-rust" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-white break-words">{text.title}</span>
                    <span className="block text-xs text-hud-cream-dim line-clamp-2">{text.detail}</span>
                    <span className="block text-xs text-hud-cream-mute">Their mail from this address isn't being handled yet.</span>
                  </span>
                </div>
                <div className="mt-1.5 flex gap-2 pl-7">
                  <button
                    type="button" disabled={!!resolving} onClick={() => resolveSender(s, true)}
                    className="inline-flex items-center justify-center gap-1.5 min-h-[44px] flex-1 rounded-lg bg-hud-gold px-3 text-sm font-semibold text-hud-bg-deep disabled:opacity-60 touch-manipulation"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Add to {s.contact_name.split(' ')[0] || 'contact'}
                  </button>
                  <button
                    type="button" disabled={!!resolving} onClick={() => resolveSender(s, false)}
                    className="inline-flex items-center justify-center min-h-[44px] rounded-lg border border-hud-bg-elev px-4 text-sm font-medium text-hud-cream-dim disabled:opacity-60 touch-manipulation"
                  >
                    Not them
                  </button>
                </div>
              </div>
            );
          })}

          {unread > 0 && (
            <Link to="/conversations" className={linkRow} data-testid="myday-unread">
              <MessageSquare className="w-4 h-4 shrink-0 text-hud-teal" />
              <span className="min-w-0 flex-1 text-sm font-medium text-white">Unread message{unread === 1 ? '' : 's'}</span>
              <Count n={unread} />
            </Link>
          )}

          {clear && <Quiet>Nothing is waiting on you.</Quiet>}
        </div>
      )}
    </Card>
  );
}

// ── Next up ──────────────────────────────────────────────────────────────────────────────────

function NextUpCard({ orgId, userId }: { orgId: string; userId: string }) {
  const card = useCard<{ rows: NextUpRow[]; note: string | null; problem: string | null }>(async () => {
    const res = await getMyUpcomingAppointments(userId, orgId, NEXT_UP_MAX);
    if (res.error && res.data.length === 0) throw res.error;
    const rows = nextUpRows(res.data, new Date(), 7, NEXT_UP_MAX);
    return {
      rows,
      note: nextUpNote({ connected: res.googleConnected, rows, max: NEXT_UP_MAX }),
      problem: res.error ? `Couldn't load OS appointments: ${res.error.message}` : null,
    };
  }, `${orgId}:${userId}`);

  const data = card.data;
  return (
    <Card title="Next up" icon={CalendarDays} to="/calendars" linkLabel="Open calendar" testId="myday-next-up">
      {card.loading && <Skeleton />}
      {card.error && <Problem>Couldn't load your calendar: {card.error}</Problem>}
      {data && (
        <div className="space-y-1">
          {data.problem && <Problem>{data.problem}</Problem>}
          {data.rows.map((row) => (
            <Link key={row.id} to={row.href} className={linkRow}>
              <span className="w-[5.5rem] shrink-0 text-xs leading-snug">
                <span className={`block font-medium ${row.day === 'Today' ? 'text-hud-gold-soft' : 'text-hud-cream-soft'}`}>{row.day}</span>
                <span className="block text-hud-cream-dim">{row.time}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-white">{row.title}</span>
                {row.detail && <span className="block truncate text-xs text-hud-cream-dim">{row.detail}</span>}
              </span>
            </Link>
          ))}
          {data.rows.length === 0 && !data.problem && <Quiet>Nothing on the OS calendar in the next 7 days.</Quiet>}
          {data.note && <p className="py-1 text-xs text-hud-cream-mute">{data.note}</p>}
        </div>
      )}
    </Card>
  );
}

// ── My tasks ─────────────────────────────────────────────────────────────────────────────────

const taskKey = (t: UnifiedTask) => `${t.parentType}-${t.id}`;

function TasksCard({ orgId }: { orgId: string }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const card = useCard<UnifiedTask[]>(() => getMyTasks(user!.id, orgId), `${orgId}:${user?.id}`);
  // Completed from this card: key → the status to put back on undo. They stay listed (struck through).
  const [done, setDone] = useState<Record<string, UnifiedTaskStatus>>({});
  const [kept, setKept] = useState<Record<string, UnifiedTask>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const picked = useMemo(() => pickDayTasks(card.data ?? [], new Date(), TASKS_MAX), [card.data]);
  const rows = useMemo(() => {
    const listed = new Set(picked.rows.map((r) => taskKey(r.task)));
    // A task completed here drops out of the next refresh: keep its row until the page is left, so it can be undone.
    const finished = Object.entries(kept)
      .filter(([key]) => done[key] && !listed.has(key))
      .map(([, task]) => ({ task, bucket: 'today' as const }));
    return [...picked.rows, ...finished];
  }, [picked, kept, done]);

  async function toggle(task: UnifiedTask) {
    if (!user) return;
    const key = taskKey(task);
    if (busy[key]) return;
    const previous = done[key];
    const completing = previous === undefined;
    const restore = task.status === 'completed' || task.status === 'cancelled' ? 'todo' : task.status;

    setBusy((b) => ({ ...b, [key]: true }));
    // Optimistic: flip the row now, put it back if the save fails.
    setDone((d) => {
      const next = { ...d };
      if (completing) next[key] = restore; else delete next[key];
      return next;
    });
    if (completing) setKept((k) => ({ ...k, [key]: task }));
    try {
      await updateTaskStatus(task, completing ? 'completed' : previous, user);
      // Reopened: it may have left the list on a refresh since, so fetch it back.
      if (!completing) card.reload();
    } catch (e) {
      setDone((d) => {
        const next = { ...d };
        if (completing) delete next[key]; else next[key] = previous;
        return next;
      });
      showToast('error', completing ? "Couldn't complete the task" : "Couldn't reopen the task", `${task.title}: ${errText(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  return (
    <Card title="My tasks" icon={ListChecks} to="/calendars?tab=tasks" linkLabel="All tasks" testId="myday-tasks">
      {card.loading && <Skeleton />}
      {card.error && <Problem>Couldn't load your tasks: {card.error}</Problem>}
      {card.data && (
        <>
          <ul>
            {rows.map((row) => {
              const { task } = row;
              const key = taskKey(task);
              const isDone = done[key] !== undefined;
              return (
                <li key={key} className="flex items-center gap-1 -ml-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(task)}
                    disabled={!!busy[key]}
                    aria-pressed={isDone}
                    aria-label={isDone ? `Reopen ${task.title}` : `Complete ${task.title}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full touch-manipulation active:scale-95 disabled:opacity-60"
                  >
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors ${isDone ? 'border-hud-emerald bg-hud-emerald text-hud-bg-deep' : 'border-hud-cream-mute text-transparent'}`}>
                      {busy[key] ? <Loader2 className="h-3.5 w-3.5 animate-spin text-hud-cream-soft" /> : <Check className="h-4 w-4" strokeWidth={3} />}
                    </span>
                  </button>
                  <Link to={task.parentHref ?? '/calendars?tab=tasks'} className="min-w-0 flex-1 min-h-[44px] flex flex-col justify-center py-1 touch-manipulation">
                    <span className={`block truncate text-sm font-medium ${isDone ? 'text-hud-cream-mute line-through' : 'text-white'}`}>{task.title}</span>
                    <span className="block truncate text-xs text-hud-cream-dim">
                      {isDone
                        ? 'Done · tap the circle to undo'
                        : <><span className={row.bucket === 'overdue' ? 'text-hud-rust' : undefined}>{taskDueLabel(row)}</span>{task.parentLabel ? ` · ${task.parentLabel}` : ''}</>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {rows.length === 0 && <Quiet>Nothing overdue or due today or tomorrow.</Quiet>}
          {picked.more > 0 && <p className="py-1 text-xs text-hud-cream-mute">+{picked.more} more overdue or due by tomorrow</p>}
        </>
      )}
    </Card>
  );
}

// ── Agents ───────────────────────────────────────────────────────────────────────────────────

interface AgentsData {
  overview: Settled<OverviewAgent[]> | null;
  harvey: Settled<HarveyStatusRow | null> | null;
  /** Clara's thread, when the signed-in user has one. */
  clara: AgentThreadPulse | null;
}

function AgentsCard({ orgId, canAgents, canHarvey }: { orgId: string; canAgents: boolean; canHarvey: boolean }) {
  const { hasPermission } = useAuth();
  const canClara = hasPermission('personal_assistant.view');

  const card = useCard<AgentsData>(async () => {
    const [overview, harvey, clara] = await Promise.allSettled([
      canAgents ? getOverview(orgId).then((o) => o.agents ?? []) : Promise.resolve(null),
      canHarvey ? getHarveyStatus(orgId) : Promise.resolve(undefined),
      canClara
        ? getPinnedAgentThreads().then((threads) => {
          const t = matchPinnedAgent(threads, 'clara');
          return t ? getAgentThreadPulse(t.channel_id, t.agent_user_id) : null;
        })
        : Promise.resolve(null),
    ]);
    const o = settle(overview);
    const h = settle(harvey);
    return {
      overview: o.ok ? (o.value ? { ok: true, value: o.value } : null) : o,
      harvey: h.ok ? (h.value === undefined ? null : { ok: true, value: h.value }) : h,
      clara: clara.status === 'fulfilled' ? clara.value : null,
    };
  }, `${orgId}:${canAgents}:${canHarvey}:${canClara}`);

  const now = Date.now();
  const fromOverview = (slug: string): AgentLine => {
    const o = card.data?.overview;
    if (!o) return { tone: 'muted', text: '' };
    if (!o.ok) return { tone: 'muted', text: `Couldn't load status: ${o.error}` };
    return agentLine(o.value.find((a) => a.slug === slug), now);
  };
  const lines: Array<{ name: string; to: string | null; line: AgentLine }> = [];
  // Clara answers from the cloud and never polls the OS, so with no heartbeat her thread is the health signal.
  const claraPolls = card.data?.overview?.ok && !!card.data.overview.value.find((a) => a.slug === 'clara')?.heartbeat?.last_poll_at;
  if (card.data?.clara && !claraPolls) {
    lines.push({ name: 'Clara', to: '/clara', line: threadAgentLine(card.data.clara, now) });
  } else if (card.data?.overview) {
    lines.push({ name: 'Clara', to: canClara ? '/clara' : null, line: fromOverview('clara') });
  }
  if (card.data?.overview) {
    lines.push({ name: 'FRIDAY', to: canClara ? '/clara?agent=friday' : null, line: fromOverview('friday') });
  }
  if (card.data?.harvey) {
    const h = card.data.harvey;
    lines.push({ name: 'Harvey', to: '/harvey', line: h.ok ? harveyLine(h.value, now) : { tone: 'muted', text: `Couldn't load status: ${h.error}` } });
  }

  return (
    <Card title="Agents" icon={Bot} to={canAgents ? '/agent-health' : undefined} linkLabel="Agent health" testId="myday-agents">
      {card.loading && <Skeleton />}
      {card.error && <Problem>Couldn't load agent status: {card.error}</Problem>}
      {lines.map(({ name, to, line }) => {
        const body = (
          <>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[line.tone]}`} aria-hidden />
            <span className="w-14 shrink-0 text-sm font-medium text-white">{name}</span>
            <span className={`min-w-0 flex-1 text-xs leading-snug ${line.tone === 'bad' ? 'text-hud-plum' : line.tone === 'warn' ? 'text-hud-rust' : 'text-hud-cream-dim'}`}>{line.text}</span>
            {to && <ChevronRight className="w-4 h-4 shrink-0 text-hud-cream-mute" />}
          </>
        );
        return to
          ? <Link key={name} to={to} className={linkRow}>{body}</Link>
          : <div key={name} className={linkRow}>{body}</div>;
      })}
    </Card>
  );
}

// ── My day ───────────────────────────────────────────────────────────────────────────────────

/**
 * The top of the dashboard on every device: what is waiting on the owner, what is next on the
 * calendar, what is due, and whether the agents are healthy, with Clara one tap away. One column on
 * a phone, two from `md` up. Each card loads and fails on its own.
 */
export function MyDay() {
  const { user, hasPermission, isFeatureEnabled } = useAuth();
  if (!user?.organization_id) return null;
  const orgId = user.organization_id;

  const canClara = hasPermission('personal_assistant.view');
  const canCalendar = hasPermission('calendars.view') && isFeatureEnabled('calendars');
  const canTasks = hasPermission('tasks.view') && isFeatureEnabled('tasks');
  const canAgents = hasPermission('agent_tasks.view') && isFeatureEnabled('agent_tasks');
  const canHarvey = hasPermission('harvey.view') && isFeatureEnabled('harvey');

  return (
    <section aria-label="My day" className="space-y-3" data-testid="my-day">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">My day</h2>
          <p className="text-xs text-hud-cream-dim">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
        {canClara && (
          <Link
            to="/clara"
            data-testid="myday-ask-clara"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-hud-gold px-6 min-h-[48px] text-base font-semibold text-hud-bg-deep touch-manipulation active:scale-[0.98] sm:w-auto"
          >
            <Sparkles className="h-5 w-5" />
            Ask Clara
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
        <NeedsYouCard orgId={orgId} />
        {canCalendar && <NextUpCard orgId={orgId} userId={user.id} />}
        {canTasks && <TasksCard orgId={orgId} />}
        {(canAgents || canHarvey) && <AgentsCard orgId={orgId} canAgents={canAgents} canHarvey={canHarvey} />}
      </div>
    </section>
  );
}
