/**
 * Harvey (personal-brand outbound agent) module data.
 *
 * Harvey runs on the owner's Linux box and PULLS from the OS: he reports a snapshot, his pipeline and
 * an activity feed into harvey_status / harvey_prospects / harvey_events (migration
 * 20261031400000_harvey_module.sql) and takes commands from harvey_commands. Draft emails are decided
 * in the shared approval queue (/automation/approvals, agent_slug 'harvey'), not here.
 * The pure helpers below are unit-tested in harvey.test.ts.
 */
import { supabase } from '../lib/supabase';

export interface HarveySnapshot {
  running?: boolean;
  reported_at?: string;
  paused?: boolean;
  paused_reason?: string;
  paused_automatically?: boolean;
  quiet_hours?: boolean;
  quiet_window?: string;
  heartbeat_minutes?: number;
  email?: { provider: string; require_approval: boolean; daily_cap: number; sent_today: number };
  pending_review?: number;
  approved_waiting?: number;
  prospects?: Record<string, number>;
  open_conversations?: number;
  claude_calls_today?: number;
  brain?: { ok?: boolean; reason?: string } & Record<string, unknown>;
  hunter_searches_left?: number | null;
  mail_read?: { ok: boolean; error?: string } | null;
  linkedin?: HarveyLinkedIn;
  sms?: { enabled: boolean; daily_cap: number | null; sent_today: number };
  safety?: SafetyLimit[];
}

/** An approved LinkedIn draft waiting for the owner to send it by hand (assist mode). */
export interface LinkedInQueueItem {
  outbox_id: string;
  prospect_id: string;
  name: string;
  company: string;
  title?: string;
  profile_url: string;
  kind: 'connect' | 'message' | 'reply';
  body: string;
  approved_at?: string | null;
}

export interface HarveyLinkedIn {
  enabled: boolean;
  mode: 'off' | 'assist' | 'auto';
  tripped_until?: string | null;
  disabled?: boolean;
  sent_today?: { connect: number; message: number };
  weekly_connections_sent?: number;
  limits?: { connects_per_day: number; messages_per_day: number; connects_per_week: number };
  /** Only reported in assist mode. */
  queue?: LinkedInQueueItem[];
}

/** One sending ceiling Harvey enforces, with today's (or this week's) usage. */
export interface SafetyLimit {
  channel: string;
  label: string;
  cap: number;
  used: number;
  period: 'day' | 'week';
  state: 'ok' | 'near' | 'full' | 'tripped';
}

export interface HarveyStatusRow { snapshot: HarveySnapshot; updated_at: string }

export interface HarveyProspect {
  prospect_id: string;
  name: string;
  title: string;
  company: string;
  email_status: string | null;
  stage: string;
  score: number | null;
  last_event: string | null;
  last_event_at: string | null;
  next_step_at: string | null;
  data: { email?: string; linkedin_url?: string; source?: string; industry?: string; company_size?: string; drafts_waiting?: number; emails_sent?: number };
  updated_at: string;
}

export interface HarveyEvent {
  id: string;
  ref: string;
  at: string;
  kind: string;
  prospect_id: string | null;
  summary: string;
  data: { excerpt?: string; intent?: string; channel?: string } & Record<string, unknown>;
}

export type HarveyCommandName = 'pause' | 'resume' | 'sync_now' | 'linkedin_sent' | 'import_prospects';

export interface HarveyCommand {
  id: string;
  command: HarveyCommandName;
  status: 'queued' | 'claimed' | 'done' | 'failed';
  result: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface PendingDraft {
  id: string;
  title: string;
  description: string | null;
  requested_at: string;
  expires_at: string | null;
}

const MIGRATION_HINT = 'The HARVEY module is not available yet: migration 20261031400000_harvey_module.sql has not been applied to this database.';

function fail(error: { message?: string; code?: string } | null): Error {
  const msg = error?.message ?? 'Request failed';
  if (error?.code === 'PGRST205' || error?.code === '42P01' || /could not find the table|does not exist/i.test(msg)) return new Error(MIGRATION_HINT);
  return new Error(msg);
}

export async function getStatus(orgId: string): Promise<HarveyStatusRow | null> {
  const { data, error } = await supabase.from('harvey_status').select('snapshot,updated_at').eq('org_id', orgId).maybeSingle();
  if (error) throw fail(error);
  return (data as HarveyStatusRow | null) ?? null;
}

export async function listProspects(orgId: string, limit = 500): Promise<HarveyProspect[]> {
  const { data, error } = await supabase
    .from('harvey_prospects')
    .select('prospect_id,name,title,company,email_status,stage,score,last_event,last_event_at,next_step_at,data,updated_at')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw fail(error);
  return (data ?? []) as HarveyProspect[];
}

export async function listEvents(orgId: string, opts: { kind?: string; limit?: number } = {}): Promise<HarveyEvent[]> {
  let q = supabase.from('harvey_events').select('id,ref,at,kind,prospect_id,summary,data').eq('org_id', orgId);
  if (opts.kind) q = q.eq('kind', opts.kind);
  const { data, error } = await q.order('at', { ascending: false }).limit(opts.limit ?? 100);
  if (error) throw fail(error);
  return (data ?? []) as HarveyEvent[];
}

export async function listPendingDrafts(orgId: string): Promise<PendingDraft[]> {
  const { data, error } = await supabase
    .from('workflow_approval_queue')
    .select('id,title,description,requested_at,expires_at')
    .eq('org_id', orgId)
    .eq('source', 'agent_approval')
    .eq('agent_slug', 'harvey')
    .eq('status', 'pending_approval')
    .order('requested_at', { ascending: false })
    .limit(100);
  if (error) throw fail(error);
  return (data ?? []) as PendingDraft[];
}

export async function listCommands(orgId: string, limit = 5): Promise<HarveyCommand[]> {
  const { data, error } = await supabase
    .from('harvey_commands')
    .select('id,command,status,result,created_at,finished_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw fail(error);
  return (data ?? []) as HarveyCommand[];
}

export async function sendCommand(
  orgId: string, userId: string, command: HarveyCommandName, args: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase.from('harvey_commands').insert({ org_id: orgId, requested_by: userId, command, args });
  if (error) throw fail(error);
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

/** Harvey reports every ~60 s. */
export const LIVE_MINUTES = 3;
export const STALE_MINUTES = 15;

export type Liveness = 'live' | 'stale' | 'offline';

export function minutesSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, (now - t) / 60000);
}

export function liveness(status: HarveyStatusRow | null, now = Date.now()): { level: Liveness; reason: string } {
  if (!status) return { level: 'offline', reason: 'HARVEY has never reported to the OS' };
  const mins = minutesSince(status.updated_at, now);
  if (mins <= LIVE_MINUTES) return { level: 'live', reason: 'Reported just now' };
  if (mins <= STALE_MINUTES) return { level: 'stale', reason: `No report for ${Math.round(mins)} min` };
  return { level: 'offline', reason: mins < 120 ? `No report for ${Math.round(mins)} min` : `No report for ${Math.round(mins / 60)} h` };
}

export const STAGE_ORDER = ['new', 'queued', 'drafted', 'contacted', 'replied', 'meeting_booked', 'opted_out', 'invalid'] as const;

export function stageLabel(stage: string): string {
  return stage.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function stageTone(stage: string): 'ok' | 'bad' | 'warn' | 'muted' | 'info' {
  if (stage === 'replied' || stage === 'meeting_booked') return 'ok';
  if (stage === 'opted_out' || stage === 'invalid') return 'bad';
  if (stage === 'contacted') return 'info';
  if (stage === 'queued' || stage === 'drafted') return 'warn';
  return 'muted';
}

export function countByStage(rows: Pick<HarveyProspect, 'stage'>[]): Array<{ stage: string; n: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
  const known = STAGE_ORDER.filter((s) => counts.has(s)).map((s) => ({ stage: s as string, n: counts.get(s)! }));
  const other = [...counts.entries()].filter(([s]) => !(STAGE_ORDER as readonly string[]).includes(s)).map(([stage, n]) => ({ stage, n }));
  return [...known, ...other];
}

/** What the owner needs to look at, most urgent first. */
export function attentionItems(status: HarveyStatusRow | null, pendingDrafts: number, now = Date.now()): Array<{ tone: 'bad' | 'warn' | 'info'; text: string }> {
  const items: Array<{ tone: 'bad' | 'warn' | 'info'; text: string }> = [];
  const lv = liveness(status, now);
  if (lv.level !== 'live') items.push({ tone: lv.level === 'offline' ? 'bad' : 'warn', text: `Harvey is ${lv.level}: ${lv.reason}.` });
  const s = status?.snapshot;
  if (s?.paused) {
    items.push({
      tone: s.paused_automatically ? 'bad' : 'warn',
      text: s.paused_automatically
        ? `Sending paused automatically: ${s.paused_reason}. Check it before resuming.`
        : 'Sending is paused (by you). Nothing goes out until you resume.',
    });
  }
  if (s?.mail_read && s.mail_read.ok === false) {
    items.push({ tone: 'bad', text: `Harvey cannot read replies or bounces: ${s.mail_read.error ?? 'mailbox sign-in failed'} Run "harvey microsoft login" on the Linux box.` });
  }
  if (s?.brain && s.brain.ok === false) items.push({ tone: 'warn', text: `Harvey's brain is unavailable: ${s.brain.reason ?? 'see logs'}.` });
  if (pendingDrafts > 0) items.push({ tone: 'info', text: `${pendingDrafts} draft${pendingDrafts === 1 ? '' : 's'} waiting for your approval.` });
  const toSend = s?.linkedin?.mode === 'assist' ? (s.linkedin.queue?.length ?? 0) : 0;
  if (toSend > 0) items.push({ tone: 'info', text: `${toSend} approved LinkedIn ${toSend === 1 ? 'note is' : 'notes are'} waiting for you to send by hand (LinkedIn tab).` });
  if (s?.linkedin?.tripped_until || s?.linkedin?.disabled) {
    items.push({ tone: 'bad', text: s.linkedin.disabled ? 'LinkedIn is disabled after LinkedIn pushed back. Check it before turning it back on.' : 'LinkedIn is on a safety stop and will resume by itself.' });
  }
  const full = (s?.safety ?? []).filter((l) => l.state === 'full');
  if (full.length) items.push({ tone: 'warn', text: `Send limit reached today: ${full.map((l) => l.label).join(', ')}.` });
  return items;
}

export function eventTone(kind: string): 'ok' | 'bad' | 'warn' | 'muted' | 'info' {
  if (kind === 'reply' || kind === 'approved') return 'ok';
  if (['hard_bounce', 'soft_bounce', 'policy_block', 'complaint', 'rejected'].includes(kind)) return 'bad';
  if (kind === 'approval_lapsed' || kind === 'command') return 'warn';
  if (kind === 'sent') return 'info';
  return 'muted';
}
