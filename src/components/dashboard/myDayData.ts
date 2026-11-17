/**
 * Pure helpers behind the dashboard's "My day" block: which tasks to show, the next calendar rows
 * and the one-line state of each agent. Browser local time. Unit-tested in myDay.test.ts.
 */
import type { UnifiedTask } from '../../services/tasksHub';
import type { DashboardAppointment } from '../../services/dashboard';
import { agentStatus, ago, type OverviewAgent } from '../../services/agentOps';
import { liveness, type HarveyStatusRow } from '../../services/harvey';
import type { AgentThreadPulse } from '../../services/agentThreads';
import { addDays, getStartOfDay } from '../../utils/calendarViewUtils';
import { coversWholeDays, dayLabel, formatClock, localDayKey, mirroredAllDayDate, parseLocalDay } from '../../utils/agenda';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

// ── Tasks ────────────────────────────────────────────────────────────────────────────────────

export type TaskBucket = 'overdue' | 'today' | 'tomorrow';

export interface DayTask {
  task: UnifiedTask;
  bucket: TaskBucket;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** The local day a task is due: a date-only due date is that day, a timestamp is its local day. */
export function taskDueDay(task: Pick<UnifiedTask, 'dueDate'>): Date | null {
  if (!task.dueDate) return null;
  const d = task.dueDate.includes('T') ? new Date(task.dueDate) : parseLocalDay(task.dueDate);
  return d && !Number.isNaN(d.getTime()) ? getStartOfDay(d) : null;
}

/**
 * Open tasks that are overdue or due today / tomorrow, most pressing first (oldest due day, then
 * priority, then title), capped at `max`. `more` is how many matched beyond the cap.
 */
export function pickDayTasks(tasks: UnifiedTask[], now: Date = new Date(), max = 6): { rows: DayTask[]; more: number } {
  const today = getStartOfDay(now).getTime();
  const tomorrow = addDays(getStartOfDay(now), 1).getTime();
  const matched: Array<DayTask & { due: number }> = [];
  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    const due = taskDueDay(task)?.getTime();
    if (due === undefined || due > tomorrow) continue;
    matched.push({ task, due, bucket: due < today ? 'overdue' : due === today ? 'today' : 'tomorrow' });
  }
  matched.sort((a, b) =>
    a.due - b.due ||
    (PRIORITY_RANK[a.task.priority] ?? 2) - (PRIORITY_RANK[b.task.priority] ?? 2) ||
    a.task.title.localeCompare(b.task.title));
  return { rows: matched.slice(0, max).map(({ task, bucket }) => ({ task, bucket })), more: Math.max(0, matched.length - max) };
}

/** "Overdue · Nov 9" / "Today" / "Tomorrow" */
export function taskDueLabel(row: DayTask): string {
  if (row.bucket === 'today') return 'Today';
  if (row.bucket === 'tomorrow') return 'Tomorrow';
  const day = taskDueDay(row.task);
  return day ? `Overdue · ${day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Overdue';
}

// ── Calendar ─────────────────────────────────────────────────────────────────────────────────

export interface NextUpRow {
  id: string;
  day: string;
  time: string;
  title: string;
  /** With whom / where, when the record says. */
  detail: string;
  /** In-app link; mirrored events open the calendar's agenda on their day. */
  href: string;
  synced: boolean;
}

/** The next `max` items that start (or are still running) within `days` days of now. */
export function nextUpRows(appointments: DashboardAppointment[], now: Date = new Date(), days = 7, max = 5): NextUpRow[] {
  const today = getStartOfDay(now).getTime();
  const end = addDays(getStartOfDay(now), days).getTime();
  const found: Array<{ at: number; row: NextUpRow }> = [];

  for (const a of appointments) {
    // Mirrored all-day events sit at UTC midnight of their date: place them by that date, not local time.
    const floating = !!a.allDay && a.source === 'google';
    const start = floating ? mirroredAllDayDate(a.start_at_utc).getTime() : Date.parse(a.start_at_utc);
    if (!Number.isFinite(start) || start >= end) continue;
    const rawFinish = a.end_at_utc ? (floating ? mirroredAllDayDate(a.end_at_utc).getTime() : Date.parse(a.end_at_utc)) : start;
    const finish = Number.isFinite(rawFinish) && rawFinish > start ? rawFinish : floating ? start + DAY_MS : start;
    const running = start < now.getTime();
    if (running && (floating ? finish <= today : finish < now.getTime())) continue;

    const shownDay = running ? now : new Date(start);
    found.push({ at: Math.max(start, floating ? today : now.getTime()), row: {
      id: `${a.source}-${a.id}`,
      day: dayLabel(shownDay, now),
      time: a.allDay || coversWholeDays(a.start_at_utc, a.end_at_utc) ? 'All day' : running ? 'Now' : formatClock(a.start_at_utc),
      title: a.title || '(No title)',
      detail: a.subtitle || '',
      href: a.appointmentId
        ? `/calendars?tab=list&appointmentId=${a.appointmentId}`
        : `/calendars?view=agenda&date=${localDayKey(shownDay)}`,
      synced: a.source === 'google',
    } });
  }

  return found
    .sort((a, b) => a.at - b.at || a.row.title.localeCompare(b.row.title))
    .slice(0, max)
    .map((f) => f.row);
}

/**
 * What to say about synced (Google / Microsoft) events on the Next up card when none are listed,
 * so a short list never reads as a free week. Null when synced events show or the list is full.
 */
export function nextUpNote(o: { connected: boolean; rows: Pick<NextUpRow, 'synced'>[]; max: number }): string | null {
  if (!o.connected) return 'No synced calendar events: no Google or Microsoft calendar is connected.';
  if (o.rows.some((r) => r.synced) || o.rows.length >= o.max) return null;
  return 'No synced calendar events from your connected calendar in the next 7 days.';
}

// ── Agents ───────────────────────────────────────────────────────────────────────────────────

export interface AgentLine {
  tone: Tone;
  text: string;
}

const FAILED = new Set(['failed', 'error', 'expired', 'rejected']);
const DAY_MS = 24 * 60 * 60 * 1000;

function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** One line for an OS agent (CLARA, FRIDAY, ...): offline, what failed last, what it is doing, or healthy. */
export function agentLine(agent: OverviewAgent | undefined, now: number = Date.now()): AgentLine {
  if (!agent) return { tone: 'muted', text: 'Not reporting to the OS' };

  const status = agentStatus(agent, now);
  if (status.level === 'idle') return { tone: 'muted', text: 'Has never connected to the OS' };
  if (status.level !== 'live') {
    const seen = agent.heartbeat?.last_poll_at ? `last checked in ${ago(agent.heartbeat.last_poll_at, now)}` : 'has never checked in';
    return { tone: status.level === 'offline' ? 'bad' : 'warn', text: `${status.level === 'offline' ? 'Offline' : 'Not responding'}: ${seen}` };
  }

  const sup = agent.supervisor;
  if (sup && sup.consecutive_fails > 0 && sup.last_error) return { tone: 'bad', text: `Failing: ${clip(sup.last_error)}` };

  const lastFailedAt = agent.last_error ? Date.parse(agent.last_error.at) : NaN;
  const lastRunAt = agent.last_run ? Date.parse(agent.last_run.at) : NaN;
  const lastRunFailed = !!agent.last_run && FAILED.has(agent.last_run.status);
  if (lastRunFailed || (Number.isFinite(lastFailedAt) && (!Number.isFinite(lastRunAt) || lastFailedAt >= lastRunAt))) {
    const title = agent.last_error?.title || agent.last_run?.title || 'a run';
    const at = agent.last_error?.at ?? agent.last_run?.at;
    return { tone: 'bad', text: `Last run failed ${ago(at, now)}: ${clip(title, 60)}` };
  }

  const working = agent.current[0];
  if (working) return { tone: 'ok', text: `Working on: ${clip(working.title, 60)}` };

  if (Number.isFinite(lastFailedAt) && now - lastFailedAt < DAY_MS) {
    return { tone: 'warn', text: `Running, but failed ${ago(agent.last_error!.at, now)}: ${clip(agent.last_error!.title, 50)}` };
  }
  return { tone: 'ok', text: `Healthy · checked in ${ago(agent.heartbeat?.last_poll_at, now)}` };
}

/** How long a message may sit unanswered before the line says so. */
const UNANSWERED_MS = 5 * 60 * 1000;

/**
 * One line for an agent that answers from the cloud and never polls the OS (Clara): judged by its
 * thread. A failed or unanswered last message counts only while nothing has been said since.
 */
export function threadAgentLine(pulse: AgentThreadPulse, now: number = Date.now()): AgentLine {
  const replyAt = pulse.lastReplyAt ? Date.parse(pulse.lastReplyAt) : NaN;
  const turn = pulse.lastTurn;
  const turnAt = turn ? Date.parse(turn.created_at) : NaN;
  const silentSince = Number.isFinite(turnAt) && (!Number.isFinite(replyAt) || replyAt < turnAt);
  if (turn && silentSince) {
    if (turn.status === 'failed') return { tone: 'bad', text: `Couldn't answer your last message${turn.error ? `: ${clip(turn.error, 60)}` : ''}` };
    if ((turn.status === 'sent' || turn.status === 'working') && now - turnAt > UNANSWERED_MS) {
      return { tone: 'warn', text: `No answer yet to your message from ${ago(turn.created_at, now)}` };
    }
  }
  if (!Number.isFinite(replyAt)) return { tone: 'muted', text: 'No conversation yet' };
  return { tone: 'ok', text: `Answering · last reply ${ago(pulse.lastReplyAt, now)}` };
}

/** One line for HARVEY from the status it pushes to the OS: offline, paused (and why), broken, or healthy. */
export function harveyLine(status: HarveyStatusRow | null, now: number = Date.now()): AgentLine {
  if (!status) return { tone: 'muted', text: 'Has never reported to the OS' };
  const live = liveness(status, now);
  if (live.level !== 'live') {
    return { tone: live.level === 'offline' ? 'bad' : 'warn', text: `${live.level === 'offline' ? 'Offline' : 'Not responding'}: ${live.reason.toLowerCase()}` };
  }

  const snap = status.snapshot ?? {};
  if (snap.paused) {
    const reason = snap.paused_reason ? `: ${clip(snap.paused_reason, 60)}` : '';
    return { tone: 'warn', text: `${snap.paused_automatically ? 'Paused automatically' : 'Paused'}${reason}` };
  }
  if (snap.brain && snap.brain.ok === false) return { tone: 'bad', text: `Model unavailable${snap.brain.reason ? `: ${clip(snap.brain.reason, 60)}` : ''}` };
  if (snap.mail_read && snap.mail_read.ok === false) return { tone: 'bad', text: `Cannot read mail${snap.mail_read.error ? `: ${clip(snap.mail_read.error, 60)}` : ''}` };

  const parts = ['Healthy'];
  if (snap.email) parts.push(`${snap.email.sent_today}/${snap.email.daily_cap} emails today`);
  if (snap.pending_review) parts.push(`${snap.pending_review} draft${snap.pending_review === 1 ? '' : 's'} to review`);
  return { tone: snap.pending_review ? 'warn' : 'ok', text: parts.join(' · ') };
}
