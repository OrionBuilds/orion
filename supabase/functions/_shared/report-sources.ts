/**
 * What the AI report engine (ai-report-generate) is allowed to query, and the SQL guard
 * that enforces it.
 *
 * Pure TypeScript with no Deno or npm imports, so the frontend test suite can import it too:
 * src/config/reportTemplates.test.ts checks that every report template on /reporting only
 * needs tables listed here.
 *
 * orgColumn  = the column on THIS table that scopes it to an organization. null means the
 *              table has no org column and must be scoped through a join (see orgNote).
 * userColumn = the column that means "mine" for the My Data scope (null means the table has
 *              no per-user owner, so My Data falls back to org-wide rows for it).
 * Field lists are checked against supabase/migrations (CREATE TABLE plus later ALTERs).
 */

export interface ReportDataSource {
  name: string;
  table: string;
  description: string;
  orgColumn: string | null;
  orgNote?: string;
  userColumn: string | null;
  userNote?: string;
  fields: string[];
}

export const REPORT_DATA_SOURCES: ReportDataSource[] = [
  {
    name: "contacts",
    table: "contacts",
    description: "Clients, leads and their companies. The client name for any record is COALESCE(NULLIF(c.company, ''), c.first_name || ' ' || c.last_name).",
    orgColumn: "organization_id",
    userColumn: "owner_id",
    fields: [
      "id (uuid)", "first_name (text)", "last_name (text)", "email (text)",
      "phone (text)", "company (text)", "status (text: active/inactive/archived)",
      "source (text)", "owner_id (uuid)", "department_id (uuid)",
      "lead_score (integer: 0-100)", "city (text)", "state (text)", "country (text)",
      "created_at (timestamptz)", "updated_at (timestamptz)",
    ],
  },
  {
    name: "users",
    table: "users",
    description: "Team members (staff and AI agent accounts). Lookup table: JOIN it to turn assigned_user_id / assigned_to_user_id / owner_id / agent_user_id into a person's name. Never report raw user uuids.",
    orgColumn: "organization_id",
    userColumn: null,
    fields: [
      "id (uuid)", "name (text)", "email (text)", "title (text)", "department_id (uuid)",
      "status (text: active/inactive/pending/invited/disabled)",
    ],
  },
  {
    name: "pipelines",
    table: "pipelines",
    description: "Sales pipelines for opportunities. SAM.gov government opportunities live in the pipeline named 'Government'.",
    orgColumn: "org_id",
    userColumn: null,
    fields: ["id (uuid)", "name (text)", "sort_order (integer)", "owner_agent (text)"],
  },
  {
    name: "pipeline_stages",
    table: "pipeline_stages",
    description: "Stages of a sales pipeline. Lookup table: JOIN on opportunities.stage_id for stage names; ORDER BY sort_order for funnel order.",
    orgColumn: "org_id",
    userColumn: null,
    fields: ["id (uuid)", "pipeline_id (uuid)", "name (text)", "sort_order (integer)", "aging_threshold_days (integer)"],
  },
  {
    name: "opportunities",
    table: "opportunities",
    description: "Sales opportunities and deals (including imported SAM.gov government bids)",
    orgColumn: "org_id",
    userColumn: "assigned_user_id",
    fields: [
      "id (uuid)", "contact_id (uuid)", "pipeline_id (uuid)", "stage_id (uuid)",
      "status (text: open/won/lost)", "value_amount (numeric)", "currency (text)",
      "source (text)", "assigned_user_id (uuid)", "department_id (uuid)",
      "name (text)", "lost_reason (text)", "close_date (date)", "closed_at (timestamptz)",
      "stage_changed_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "proposals",
    table: "proposals",
    description: "Proposals sent to clients. 'Signed' means signature_status = 'signed' (or status = 'accepted'). Exclude archived rows (archived_at IS NULL). contact_id can be NULL - use LEFT JOIN contacts.",
    orgColumn: "org_id",
    userColumn: "assigned_user_id",
    fields: [
      "id (uuid)", "contact_id (uuid)", "opportunity_id (uuid)", "title (text)",
      "status (text: draft/sent/viewed/accepted/rejected/expired)",
      "signature_status (text: not_sent/pending_signature/viewed/signed/declined/expired/voided)",
      "total_value (numeric)", "currency (text)", "sent_at (timestamptz)", "viewed_at (timestamptz)",
      "responded_at (timestamptz)", "signed_at (timestamptz)", "declined_at (timestamptz)",
      "assigned_user_id (uuid)", "created_by (uuid)", "archived_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "contracts",
    table: "contracts",
    description: "Contracts generated from proposals. There is no sent_at column - a contract counts as sent when status <> 'draft'. Exclude archived rows (archived_at IS NULL). contact_id can be NULL - use LEFT JOIN contacts.",
    orgColumn: "org_id",
    userColumn: "assigned_user_id",
    fields: [
      "id (uuid)", "proposal_id (uuid)", "contact_id (uuid)", "opportunity_id (uuid)", "title (text)",
      "contract_type (text)", "status (text: draft/sent/viewed/signed/declined/expired/voided)",
      "signature_status (text: not_sent/pending_signature/viewed/signed/declined/expired/voided)",
      "total_value (numeric)", "currency (text)", "effective_date (date)", "signed_at (timestamptz)",
      "declined_at (timestamptz)", "assigned_user_id (uuid)", "archived_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "project_pipelines",
    table: "project_pipelines",
    description: "Delivery boards for projects. The engineering board is the one named 'Engineering' (owner_agent = 'friday').",
    orgColumn: "org_id",
    userColumn: null,
    fields: ["id (uuid)", "name (text)", "sort_order (integer)", "owner_agent (text)"],
  },
  {
    name: "project_stages",
    table: "project_stages",
    description: "Stages of a project board. Lookup table: JOIN on projects.stage_id for stage names; ORDER BY sort_order.",
    orgColumn: "org_id",
    userColumn: null,
    fields: ["id (uuid)", "pipeline_id (uuid)", "name (text)", "sort_order (integer)", "sla_days (integer)"],
  },
  {
    name: "projects",
    table: "projects",
    description: "Client delivery projects. contact_id is the client (can be NULL - use LEFT JOIN contacts).",
    orgColumn: "org_id",
    userColumn: "assigned_user_id",
    fields: [
      "id (uuid)", "contact_id (uuid)", "opportunity_id (uuid)", "proposal_id (uuid)",
      "pipeline_id (uuid)", "stage_id (uuid)", "name (text)",
      "status (text: active/on_hold/completed/cancelled)", "priority (text: low/medium/high/urgent)",
      "risk_level (text: low/medium/high/critical)", "progress_percent (integer 0-100)",
      "budget_amount (numeric)", "actual_cost (numeric)", "currency (text)",
      "start_date (date)", "target_end_date (date)", "actual_end_date (date)",
      "assigned_user_id (uuid)", "department_id (uuid)", "stage_changed_at (timestamptz)",
      "created_at (timestamptz)", "updated_at (timestamptz)",
    ],
  },
  {
    name: "project_tasks",
    table: "project_tasks",
    description: "Tasks inside delivery projects. Open = status NOT IN ('completed','cancelled'); overdue = open AND due_date < CURRENT_DATE.",
    orgColumn: "org_id",
    userColumn: "assigned_user_id",
    fields: [
      "id (uuid)", "project_id (uuid)", "parent_task_id (uuid)", "assigned_user_id (uuid)", "title (text)",
      "status (text: todo/in_progress/in_review/completed/cancelled)",
      "priority (text: low/medium/high/urgent)", "due_date (date)", "completed_at (timestamptz)",
      "created_at (timestamptz)",
    ],
  },
  {
    name: "tasks",
    table: "contact_tasks",
    description: "Client and sales to-dos attached to a contact. No org column - scope by joining contacts. Open = status IN ('pending','in_progress').",
    orgColumn: null,
    orgNote: "JOIN public.contacts c ON c.id = public.contact_tasks.contact_id WHERE c.organization_id = '{{ORG_ID}}'",
    userColumn: "assigned_to_user_id",
    fields: [
      "id (uuid)", "contact_id (uuid)", "title (text)",
      "status (text: pending/in_progress/completed/cancelled)", "priority (text: low/medium/high)",
      "assigned_to_user_id (uuid)", "created_by_user_id (uuid)", "opportunity_id (uuid)",
      "source_meeting_id (uuid)", "due_date (timestamptz)", "completed_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "meetings",
    table: "meeting_transcriptions",
    description: "Recorded and imported client meetings (Google Meet, Teams, Zoom, manual). action_items and key_points are JSON arrays - count with jsonb_array_length(action_items). Time filter on meeting_date. contact_id can be NULL - use LEFT JOIN contacts.",
    orgColumn: "org_id",
    userColumn: "imported_by",
    fields: [
      "id (uuid)", "contact_id (uuid)", "meeting_source (text: google_meet/zoom/teams/other/manual)",
      "meeting_title (text)", "meeting_date (timestamptz)", "duration_minutes (integer)",
      "participants (jsonb array)", "action_items (jsonb array)", "key_points (jsonb array)",
      "summary (text)", "imported_by (uuid)", "created_at (timestamptz)",
    ],
  },
  {
    name: "conversations",
    table: "conversations",
    description: "Communication threads with contacts",
    orgColumn: "organization_id",
    userColumn: "assigned_user_id",
    fields: [
      "id (uuid)", "contact_id (uuid)", "channel (text)", "status (text: open/closed/pending)",
      "assigned_user_id (uuid)", "department_id (uuid)", "unread_count (integer)",
      "created_at (timestamptz)", "last_message_at (timestamptz)",
    ],
  },
  {
    name: "messages",
    table: "messages",
    description: "Individual SMS / email / voice / webchat messages inside conversations. Use channel and direction for volume; reply time = minutes from an inbound message to the next outbound message in the same conversation. Time filter on created_at.",
    orgColumn: "organization_id",
    userColumn: null,
    userNote: "JOIN public.conversations cv ON cv.id = public.messages.conversation_id AND cv.assigned_user_id = '{{USER_ID}}'",
    fields: [
      "id (uuid)", "conversation_id (uuid)", "contact_id (uuid)",
      "channel (text: sms/email/voice/webchat/social_dm/vapi_voice/vapi_sms/vapi_webchat)",
      "direction (text: inbound/outbound/system)", "status (text: pending/sent/delivered/failed/read)",
      "sent_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "appointments",
    table: "appointments",
    description: "Scheduled appointments and calls",
    orgColumn: "org_id",
    userColumn: "assigned_user_id",
    fields: [
      "id (uuid)", "contact_id (uuid)", "calendar_id (uuid)",
      "status (text: scheduled/completed/canceled/no_show)",
      "source (text)", "assigned_user_id (uuid)",
      "start_at_utc (timestamptz)", "end_at_utc (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "agent_task_schedules",
    table: "agent_task_schedules",
    description: "Recurring jobs run by the AI agents (CLARA, FRIDAY). Lookup table for agent_task_runs.schedule_id: title is the job name, agent_slug the agent.",
    orgColumn: "org_id",
    userColumn: null,
    fields: [
      "id (uuid)", "agent_user_id (uuid)", "agent_slug (text: clara/friday)", "task_key (text)",
      "title (text)", "cadence (text: hourly/daily/weekly/monthly/custom_cron)",
      "mode (text: off/shadow/active)", "risk_tier (text)", "output_kind (text)",
      "next_run_at (timestamptz)", "last_run_at (timestamptz)",
    ],
  },
  {
    name: "agent_task_runs",
    table: "agent_task_runs",
    description: "Each execution of an agent job. Success = status IN ('completed','approved'); failure = status IN ('failed','expired_lease','rejected'). Time filter on scheduled_for.",
    orgColumn: "org_id",
    userColumn: null,
    fields: [
      "id (uuid)", "schedule_id (uuid)", "agent_user_id (uuid)", "scheduled_for (timestamptz)",
      "status (text: claimed/running/awaiting_approval/approved/rejected/completed/failed/expired_lease)",
      "mode_at_run (text: shadow/active)", "attempt (integer)", "started_at (timestamptz)",
      "finished_at (timestamptz)", "error (text)", "created_at (timestamptz)",
    ],
  },
  {
    name: "ai_runs",
    table: "ai_agent_runs",
    description: "Conversation AI agent execution history (chat/SMS assistants)",
    orgColumn: "org_id",
    userColumn: null,
    fields: [
      "id (uuid)", "agent_id (uuid)", "contact_id (uuid)", "conversation_id (uuid)",
      "status (text: running/completed/failed)", "triggered_by (text)",
      "messages_sent (integer)", "tool_calls_count (integer)", "error_message (text)",
      "started_at (timestamptz)", "completed_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "invoices",
    table: "invoices",
    description: "Customer invoices. For revenue/money totals, JOIN contacts to exclude externally-synced (e.g. QuickBooks) invoices not linked to a CRM contact.",
    orgColumn: "org_id",
    userColumn: null,
    fields: [
      "id (uuid)", "contact_id (uuid)", "status (text: draft/sent/paid/overdue/void)",
      "total (numeric)", "currency (text)", "due_date (date)",
      "paid_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "payments",
    table: "payments",
    description: "Payment transactions. For revenue totals, JOIN contacts to exclude externally-synced payments not linked to a CRM contact.",
    orgColumn: "org_id",
    userColumn: null,
    fields: [
      "id (uuid)", "invoice_id (uuid)", "contact_id (uuid)", "amount (numeric)",
      "currency (text)", "payment_method (text)",
      "received_at (timestamptz)", "created_at (timestamptz)",
    ],
  },
  {
    name: "forms",
    table: "form_submissions",
    description: "Form submissions",
    orgColumn: "organization_id",
    userColumn: null,
    fields: [
      "id (uuid)", "form_id (uuid)", "contact_id (uuid)",
      "processed_status (text)", "submitted_at (timestamptz)",
    ],
  },
];

/** Every table a report query may read, unqualified (all live in the public schema). */
export const REPORT_ALLOWED_TABLES: ReadonlySet<string> = new Set(
  REPORT_DATA_SOURCES.map((ds) => ds.table),
);

/**
 * Non-public schemas and server functions a report query must never touch. The query runs
 * with the service role (RLS bypassed), so without this a prompt like "list every user's
 * password hash" could be planned as SELECT ... FROM auth.users.
 */
const FORBIDDEN_SCHEMAS = [
  "auth", "vault", "storage", "extensions", "information_schema", "pg_catalog", "pg_toast",
  "cron", "net", "realtime", "supabase_functions", "supabase_migrations", "graphql",
  "graphql_public", "pgsodium", "pgsodium_masks", "pgbouncer", "private", "_realtime",
  "_analytics", "pgmq",
];
const FORBIDDEN_SCHEMA_RE = new RegExp(`(^|[^\\w$])"?(${FORBIDDEN_SCHEMAS.join("|")}|backup_\\w+)"?\\s*\\.`, "i");
// pg_* covers every pg_catalog relation and admin function (pg_sleep, pg_read_file, pg_ls_dir,
// pg_terminate_backend, ...), which stay reachable unqualified even with an empty search_path.
const FORBIDDEN_FUNC_RE = /(^|[^\w$])(pg_\w+|dblink\w*|lo_(import|export|get|put|from_bytea)|set_config|current_setting|query_to_xml\w*|xpath\w*)\b/i;
const PUBLIC_TABLE_RE = /(^|[^\w$])"?public"?\s*\.\s*"?([a-z_][a-z0-9_$]*)"?/gi;

/** Tables referenced as public.<table> in a query, lower-cased and de-duplicated. */
export function findReferencedTables(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(PUBLIC_TABLE_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

/**
 * Throws unless the query only reads allowed public tables. Pairs with the read-only checks in
 * sanitizeSQL (ai-report-generate) and exec_report_query: those stop writes, this stops reads
 * outside the report data sources. With the RPC's empty search_path an unqualified table name
 * does not resolve, so public.<table> is the only way to name a table.
 */
export function assertReportSqlAllowed(sql: string): void {
  if (/U&"/i.test(sql)) throw new Error("Unicode-escaped identifiers are not allowed");
  if (FORBIDDEN_SCHEMA_RE.test(sql)) throw new Error("Query references a system schema");
  if (FORBIDDEN_FUNC_RE.test(sql)) throw new Error("Query calls a disallowed system function");
  const tables = findReferencedTables(sql);
  if (tables.length === 0) throw new Error("Query must read at least one public.<table>");
  const blocked = tables.filter((t) => !REPORT_ALLOWED_TABLES.has(t));
  if (blocked.length > 0) {
    throw new Error(`Query reads tables outside the report data sources: ${blocked.join(", ")}`);
  }
}
