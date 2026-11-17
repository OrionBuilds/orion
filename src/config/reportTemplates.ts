import type { ReportCategory } from '../types/aiReports';

/**
 * Report templates offered as chips on /reporting.
 *
 * Each template only asks for data the report engine (ai-report-generate) can query:
 * `tables` lists every table the report needs, and reportTemplates.test.ts checks them
 * against REPORT_ALLOWED_TABLES in supabase/functions/_shared/report-sources.ts, the same
 * allowlist the engine enforces on generated SQL. A chip is hidden when any of its
 * `featureFlags` is off for the org, so nobody is offered a report on a module they don't use.
 *
 * Prompts deliberately avoid dates ("this quarter", "last 30 days"): the range dropdown next
 * to the prompt box sets the period, and a date in the prompt would contradict it.
 *
 * Left out on purpose: revenue / invoice / payment templates (the Payments data was cleared
 * on 2026-10-28 when QuickBooks was retired, see 20261029015522_drop_payments_backup) and
 * marketing templates (forms, campaigns) - the business now sells engineering only.
 */
export interface ReportTemplate {
  id: string;
  /** Chip text. */
  label: string;
  /** What is sent to the engine when the chip is used. */
  prompt: string;
  category: ReportCategory;
  /** Every table the report reads (public schema, unqualified). */
  tables: string[];
  /** Feature flags that must all be enabled for the chip to show. */
  featureFlags: string[];
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'project-status-by-client',
    label: 'Project status and progress by client',
    prompt:
      'Project status and progress by client: for current engineering projects, show each client with their projects, current stage, status, progress %, risk level and target end date. Flag projects past their target end date and count projects by stage.',
    category: 'projects',
    tables: ['projects', 'project_stages', 'project_pipelines', 'contacts'],
    featureFlags: ['projects'],
  },
  {
    id: 'open-tasks-by-assignee',
    label: 'Open tasks by assignee and due date',
    prompt:
      'Open tasks by assignee and due date: count open project tasks and client tasks for each team member, split into overdue, due within a week and due later, and show which projects carry the most overdue tasks.',
    category: 'ops',
    tables: ['project_tasks', 'projects', 'contact_tasks', 'contacts', 'users'],
    featureFlags: ['projects'],
  },
  {
    id: 'pipeline-value-by-stage',
    label: 'Pipeline value by stage',
    prompt:
      'Pipeline value by stage: number and total value of open opportunities in each stage, in funnel order, for each pipeline, plus the largest open deals and their clients.',
    category: 'sales',
    tables: ['opportunities', 'pipeline_stages', 'pipelines', 'contacts'],
    featureFlags: ['opportunities'],
  },
  {
    id: 'won-vs-lost',
    label: 'Won vs lost opportunities',
    prompt:
      'Won vs lost opportunities closed in the selected period: count and value of won and lost deals, win rate, the most common lost reasons, and a month-by-month trend.',
    category: 'sales',
    tables: ['opportunities', 'pipelines', 'contacts'],
    featureFlags: ['opportunities'],
  },
  {
    id: 'proposals-contracts-signed',
    label: 'Proposals and contracts sent vs signed',
    prompt:
      'Proposals and contracts sent vs signed: number and value of proposals sent, viewed, signed and declined; contracts sent vs signed; signing rate; average days from proposal sent to signed; broken down by client.',
    category: 'sales',
    tables: ['proposals', 'contracts', 'contacts'],
    featureFlags: ['proposals'],
  },
  {
    id: 'meetings-per-client',
    label: 'Meetings held per client with action items',
    prompt:
      'Meetings held per client: number of meetings, total meeting hours and action items captured for each client, split by meeting source (Google Meet, Teams, Zoom, manual), with a weekly trend.',
    category: 'ops',
    tables: ['meeting_transcriptions', 'contacts'],
    featureFlags: [],
  },
  {
    id: 'conversations-by-channel',
    label: 'Conversations by channel and reply time',
    prompt:
      'Conversations by channel and reply time: inbound vs outbound message volume per channel (email, SMS, voice, webchat), number of active conversations, and average reply time from an inbound message to our next outbound message.',
    category: 'ops',
    tables: ['messages', 'conversations'],
    featureFlags: ['conversations'],
  },
  {
    id: 'agent-run-outcomes',
    label: 'Agent run success and failures',
    prompt:
      'Agent run success and failures: runs per agent and per scheduled job, success vs failure counts and success rate, the most common errors, and a daily trend.',
    category: 'ops',
    tables: ['agent_task_runs', 'agent_task_schedules', 'users'],
    featureFlags: ['agent_tasks'],
  },
  {
    id: 'government-opportunities',
    label: 'SAM.gov opportunities by stage',
    prompt:
      'Government opportunities imported from SAM.gov: opportunities in the Government pipeline by stage with count and total value, how many were imported in the selected period, and won vs lost.',
    category: 'sales',
    tables: ['opportunities', 'pipelines', 'pipeline_stages'],
    featureFlags: ['government'],
  },
];

/** Templates whose modules are all enabled for the current org. */
export function getAvailableReportTemplates(
  isFeatureEnabled: (flag: string) => boolean,
  templates: ReportTemplate[] = REPORT_TEMPLATES,
): ReportTemplate[] {
  return templates.filter((t) => t.featureFlags.every((flag) => isFeatureEnabled(flag)));
}

/**
 * Follow-up chips shown once a thread has an answer. They only reshape the previous report
 * (same tables, new grouping or filter), so they are always answerable when it was.
 */
export const REFINEMENT_SUGGESTIONS = [
  'Break that down by month',
  'Show it per client',
  'Compare with the previous period',
  'Only show the top 10',
];
