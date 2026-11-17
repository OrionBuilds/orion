/**
 * The static list of checks (what the page shows before anything runs) plus the probe definitions
 * shared by the edge function. Dynamic checks (one per cron job, bucket, OAuth connection) appear
 * under their group at run time with ids prefixed by the catalogue id (e.g. infra.cron.<job>).
 */

import type { CheckCatalogueEntry, CheckGroup } from './types.ts';
import { ENTITY_SPECS, crudCheckId } from './crud-registry.ts';

export interface AgentIdentity {
  slug: string;
  label: string;
  email: string;
}

/** Override with env SYSTEM_HEALTH_AGENTS='[{"slug":"clara","label":"CLARA","email":"..."}]'. */
export const DEFAULT_AGENTS: AgentIdentity[] = [
  { slug: 'clara', label: 'CLARA', email: 'clara@example.com' },
  { slug: 'friday', label: 'FRIDAY', email: 'friday@example.com' },
];

/**
 * Edge functions pinged with OPTIONS. Every one listed answers the CORS preflight before doing any
 * work (checked: the OPTIONS branch is the first statement in its handler), so the ping can never
 * trigger processing. Do not add a function here without checking that.
 */
export const EDGE_FUNCTION_PINGS: string[] = [
  'system-health',
  'email-send',
  'twilio-sms-send',
  'booking-api',
  'form-submit',
  'survey-submit',
  'clara-chat',
  'assistant-chat',
  'drive-api',
  'gmail-api',
  'microsoft-mail',
  'microsoft-calendar',
  'project-files',
  'secrets-api',
  'proposal-ai-generate',
  'contract-ai-generate',
  'signature-send',
  'meet-processing-job',
  'notification-dispatcher',
  'agent-task-builder',
  'agent-liveness-alarm',
];

export interface QueueProbe {
  id: string;
  label: string;
  table: string;
  orgColumn: 'org_id' | 'organization_id';
  /** Column whose age is measured (oldest pending row). */
  ageColumn: string;
  /** PostgREST-style filters: [column, operator, value]. "now" is replaced at run time. */
  filters: Array<[string, 'eq' | 'in' | 'is' | 'lte', unknown]>;
  warnAgeMin: number;
  failAgeMin: number;
  group: CheckGroup;
}

export const QUEUE_PROBES: QueueProbe[] = [
  // event_outbox / workflow_jobs / delayed_action_queue / marketing_event_outbox probes were removed
  // with the retired workflow engine and Marketing Pixels: nothing marks event_outbox rows processed
  // any more (notification-dispatcher is fired per insert), and the other three tables are dropped.
  { id: 'infra.queue.webhook_deliveries', label: 'Outgoing webhooks', table: 'webhook_deliveries', orgColumn: 'org_id',
    ageColumn: 'created_at', filters: [['status', 'eq', 'pending']], warnAgeMin: 15, failAgeMin: 120, group: 'infrastructure' },
  { id: 'infra.queue.report_emails', label: 'Report email queue', table: 'report_email_queue', orgColumn: 'organization_id',
    ageColumn: 'created_at', filters: [['status', 'eq', 'pending']], warnAgeMin: 30, failAgeMin: 180, group: 'infrastructure' },
  { id: 'infra.queue.gmail_sync', label: 'Gmail sync jobs', table: 'gmail_sync_jobs', orgColumn: 'organization_id',
    ageColumn: 'run_at', filters: [['status', 'in', ['queued', 'retry']], ['run_at', 'lte', 'now']], warnAgeMin: 10, failAgeMin: 60, group: 'infrastructure' },
  { id: 'infra.queue.gcal_sync', label: 'Google Calendar sync jobs', table: 'google_calendar_sync_jobs', orgColumn: 'org_id',
    ageColumn: 'scheduled_at', filters: [['status', 'eq', 'pending'], ['scheduled_at', 'lte', 'now']], warnAgeMin: 10, failAgeMin: 60, group: 'infrastructure' },
  { id: 'infra.queue.clara_notifications', label: 'CLARA notifications', table: 'clara_notifications', orgColumn: 'organization_id',
    ageColumn: 'created_at', filters: [['delivered_at', 'is', null]], warnAgeMin: 15, failAgeMin: 120, group: 'infrastructure' },
  { id: 'agents.requests', label: 'Inter-agent requests', table: 'agent_requests', orgColumn: 'org_id',
    ageColumn: 'created_at', filters: [['status', 'eq', 'queued']], warnAgeMin: 15, failAgeMin: 60, group: 'agents' },
];

export function buildCatalogue(agents: AgentIdentity[] = DEFAULT_AGENTS): CheckCatalogueEntry[] {
  const out: CheckCatalogueEntry[] = [];
  for (const s of ENTITY_SPECS) {
    out.push({ id: crudCheckId(s.key), group: 'data', name: s.label, description: s.description });
  }
  out.push({ id: 'crud.cleanup', group: 'data', name: 'Test data cleanup', description: 'All tagged test rows removed (service role), plus a tag sweep.' });

  out.push(
    { id: 'integrations.google', group: 'integrations', name: 'Google connections', description: 'Per connected account: refresh failures, token expiry, live token check.' },
    { id: 'integrations.microsoft', group: 'integrations', name: 'Microsoft connections', description: 'Per connected account: status, refresh errors, live Graph /me check.' },
    { id: 'integrations.twilio', group: 'integrations', name: 'Twilio', description: 'Account status via GET /Accounts/{sid} (no SMS sent).' },
    { id: 'integrations.resend', group: 'integrations', name: 'Resend', description: 'API key valid and sending domain verified (no email sent).' },
    { id: 'integrations.anthropic', group: 'integrations', name: 'Anthropic', description: 'Key valid via GET /v1/models (no tokens spent).' },
    { id: 'integrations.openai', group: 'integrations', name: 'OpenAI', description: 'Key valid via GET /v1/models, when configured.' },
    { id: 'integrations.gemini', group: 'integrations', name: 'Gemini', description: 'Key valid via GET /v1/models, when configured.' },
    { id: 'integrations.elevenlabs', group: 'integrations', name: 'ElevenLabs', description: 'Key valid via GET /v1/user (no audio generated).' },
  );

  out.push(
    { id: 'infra.db_latency', group: 'infrastructure', name: 'Database latency', description: 'Median of 3 indexed reads through PostgREST.' },
    { id: 'infra.history', group: 'infrastructure', name: 'Run history table', description: 'system_health_runs exists and accepts this run.' },
    { id: 'infra.cron', group: 'infrastructure', name: 'Cron jobs', description: 'Per pg_cron job: last run, failures in 24h, overdue.' },
    { id: 'infra.storage', group: 'infrastructure', name: 'Storage buckets', description: 'Per bucket: list one object.' },
    { id: 'infra.meet_backlog', group: 'infrastructure', name: 'Meeting processing backlog', description: 'Meet/Teams sessions and transcriptions stuck in processing.' },
  );
  for (const fn of EDGE_FUNCTION_PINGS) {
    out.push({ id: `infra.edge.${fn}`, group: 'infrastructure', name: `Edge function: ${fn}`, description: 'OPTIONS preflight (no work performed).' });
  }
  for (const q of QUEUE_PROBES) {
    out.push({ id: q.id, group: q.group, name: q.label, description: `Pending rows and oldest age in ${q.table}.` });
  }

  for (const a of agents) {
    out.push(
      { id: `agents.${a.slug}.heartbeat`, group: 'agents', name: `${a.label} heartbeat`, description: 'Last poll age and poll rate (agent_heartbeats).' },
      { id: `agents.${a.slug}.schedules`, group: 'agents', name: `${a.label} schedules`, description: 'Active schedules overdue by more than 60 min.' },
      { id: `agents.${a.slug}.runs`, group: 'agents', name: `${a.label} runs`, description: 'Last run, 24h failure rate, expired leases.' },
      { id: `agents.${a.slug}.session`, group: 'agents', name: `${a.label} OS session`, description: 'Agent user has a live, refreshing auth session.' },
      { id: `agents.${a.slug}.ping`, group: 'agents', name: `${a.label} active ping`, description: 'Tagged no-op schedule claimed on the next poll.' },
    );
  }
  out.push({ id: 'agents.approvals', group: 'agents', name: 'Pending approvals', description: 'Count and age of pending approvals.' });
  return out;
}
