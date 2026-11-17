/**
 * CRUD health-check registry.
 *
 * One entry per table the app writes. Every column name here was checked against the live schema
 * of the production project (information_schema, 2026-10-29) and the migrations that created
 * it. The old client-side check failed on contacts because it inserted `created_by`, a column that
 * never existed on contacts (the real one is `created_by_user_id`) — so when adding an entry, copy
 * required columns from the migration, not from another table.
 *
 * Safety rules every entry follows:
 *  - Every test row carries the run tag ("[healthcheck] <runId>") in `tagColumn`, so a crashed run
 *    can always be swept by tag. Rows without a text column hang off a tagged parent and go with
 *    it (ON DELETE CASCADE).
 *  - Test rows are inert: drafts / inactive / mode 'off' / far-future dates / direction 'system',
 *    so no cron (reminders, approval nags, agent claims, senders) acts on them in the seconds they
 *    exist. Workflow events and outgoing webhooks for them are dropped by the
 *    skip_healthcheck_side_effects trigger (migration 20261029210000), keyed on the tagged contact.
 *  - No entry ever updates or deletes a row it did not create in this run.
 *
 * Pure module (no imports with side effects) — shared by the edge function and vitest.
 */

export type Row = Record<string, unknown>;

export interface BuildCtx {
  orgId: string;
  userId: string;
  runId: string;
  /** "[healthcheck] <runId>" — prefix of every tagged value. */
  tag: string;
  /** "healthcheck-<runId>" — for slug / key columns with format rules. */
  slug: string;
  /** ids of rows created earlier in this run, by spec key. */
  refs: Record<string, string>;
  nowIso: string;
}

export type RemoveSpec =
  | { mode: 'delete' }
  | { mode: 'archive'; patch: (ctx: BuildCtx) => Row; verifyColumn: string };

export interface CrudSpec {
  kind: 'crud';
  key: string;
  label: string;
  module: string;
  table: string;
  orgColumn: 'org_id' | 'organization_id' | null;
  dependsOn: string[];
  /** Text column whose value starts with ctx.tag. null = no text column; swept via its parent. */
  tagColumn: string | null;
  build: (ctx: BuildCtx) => Row;
  update: { column: string; value: (ctx: BuildCtx) => unknown } | null;
  remove: RemoveSpec;
  /** 'app' = the app writes audit_logs for this entity (services/audit.ts); the check writes and reads one. */
  audit: 'app' | 'none';
  /** In RLS mode these operations are expected to be refused by policy (verified, then cleaned up by service role). */
  rlsDeny?: Array<'update' | 'delete'>;
  /** Timestamp column used by the stale-row sweep (default created_at). */
  createdColumn?: string;
  description: string;
}

export interface ReadSpec {
  kind: 'read';
  key: string;
  label: string;
  module: string;
  table: string;
  orgColumn: 'org_id' | 'organization_id' | null;
  columns: string;
  description: string;
}

export type EntitySpec = CrudSpec | ReadSpec;

export const HEALTHCHECK_TAG_PREFIX = '[healthcheck]';
/** Far enough out that no reminder / confirmation / overdue cron ever considers it. */
const FAR_FUTURE = '2099-01-01T15:00:00.000Z';
const FAR_FUTURE_END = '2099-01-01T15:30:00.000Z';

export function makeTag(runId: string): string {
  return `${HEALTHCHECK_TAG_PREFIX} ${runId}`;
}

const updated = (ctx: BuildCtx) => `${ctx.tag} (updated)`;

export const ENTITY_SPECS: EntitySpec[] = [
  // ── Contacts ────────────────────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'contacts', label: 'Contacts', module: 'Contacts', table: 'contacts',
    orgColumn: 'organization_id', dependsOn: [], tagColumn: 'first_name',
    build: (c) => ({
      organization_id: c.orgId,
      first_name: c.tag,
      last_name: 'System Health',
      email: `${c.slug}@example.invalid`,
      source: 'healthcheck',
      status: 'active',
      owner_id: c.userId,
      created_by_user_id: c.userId, // NOT created_by: that column never existed on contacts
    }),
    update: { column: 'last_name', value: () => 'System Health (updated)' },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Insert, read, update and delete a tagged contact.',
  },
  {
    kind: 'crud', key: 'contact_notes', label: 'Contact notes', module: 'Contacts', table: 'contact_notes',
    orgColumn: null, dependsOn: ['contacts'], tagColumn: 'content',
    build: (c) => ({ contact_id: c.refs.contacts, user_id: c.userId, content: c.tag, title: c.tag }),
    update: { column: 'content', value: updated },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Note on the test contact.',
  },
  {
    kind: 'crud', key: 'contact_tasks', label: 'Contact tasks', module: 'Contacts', table: 'contact_tasks',
    orgColumn: null, dependsOn: ['contacts'], tagColumn: 'title',
    build: (c) => ({
      contact_id: c.refs.contacts, created_by_user_id: c.userId, title: c.tag, priority: 'low', status: 'pending',
    }),
    update: { column: 'status', value: () => 'in_progress' },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Task on the test contact (unassigned).',
  },
  // ── Custom fields / objects ─────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'custom_fields', label: 'Custom fields', module: 'Custom Fields', table: 'custom_fields',
    orgColumn: 'organization_id', dependsOn: [], tagColumn: 'name',
    build: (c) => ({
      organization_id: c.orgId,
      name: c.tag,
      field_key: c.slug.replace(/-/g, '_'),
      field_type: 'text',
      scope: 'contact',
      active: false,
      visible_in_forms: false,
      visible_in_surveys: false,
    }),
    update: { column: 'help_text', value: updated },
    remove: { mode: 'archive', patch: (c) => ({ deleted_at: c.nowIso, active: false }), verifyColumn: 'deleted_at' },
    audit: 'app',
    description: 'Inactive contact field; archived via deleted_at like the app.',
  },
  {
    kind: 'crud', key: 'custom_field_values', label: 'Custom field values', module: 'Custom Fields',
    table: 'contact_custom_field_values', orgColumn: null, dependsOn: ['contacts', 'custom_fields'], tagColumn: null,
    build: (c) => ({ contact_id: c.refs.contacts, custom_field_id: c.refs.custom_fields, value: c.tag }),
    update: { column: 'value', value: updated },
    remove: { mode: 'delete' },
    audit: 'none',
    description: 'Value of the test field on the test contact.',
  },
  {
    kind: 'crud', key: 'custom_object_definitions', label: 'Custom objects', module: 'Custom Objects',
    table: 'custom_object_definitions', orgColumn: 'organization_id', dependsOn: [], tagColumn: 'name',
    build: (c) => ({
      organization_id: c.orgId,
      slug: c.slug,
      name: c.tag,
      primary_field_key: 'name',
      field_definitions: [{ key: 'name', label: 'Name', type: 'text' }],
      active: false,
    }),
    update: { column: 'name', value: updated },
    remove: { mode: 'archive', patch: (c) => ({ deleted_at: c.nowIso, active: false }), verifyColumn: 'deleted_at' },
    audit: 'app',
    description: 'Inactive object definition; archived via deleted_at like the app.',
  },
  {
    kind: 'crud', key: 'custom_object_records', label: 'Custom object records', module: 'Custom Objects',
    table: 'custom_object_records', orgColumn: 'organization_id', dependsOn: ['custom_object_definitions', 'contacts'],
    tagColumn: 'primary_value',
    build: (c) => ({
      organization_id: c.orgId,
      object_def_id: c.refs.custom_object_definitions,
      contact_id: c.refs.contacts,
      primary_value: c.tag,
      values: { name: c.tag },
    }),
    update: { column: 'primary_value', value: updated },
    remove: { mode: 'archive', patch: (c) => ({ deleted_at: c.nowIso }), verifyColumn: 'deleted_at' },
    audit: 'app',
    description: 'Record of the test object.',
  },
  // ── Opportunities ───────────────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'pipelines', label: 'Pipelines', module: 'Opportunities', table: 'pipelines',
    orgColumn: 'org_id', dependsOn: [], tagColumn: 'name',
    build: (c) => ({ org_id: c.orgId, name: c.tag, sort_order: 9999 }),
    update: { column: 'name', value: updated },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Dedicated test pipeline (never a real one).',
  },
  {
    kind: 'crud', key: 'pipeline_stages', label: 'Pipeline stages', module: 'Opportunities', table: 'pipeline_stages',
    orgColumn: 'org_id', dependsOn: ['pipelines'], tagColumn: 'name',
    build: (c) => ({ org_id: c.orgId, pipeline_id: c.refs.pipelines, name: c.tag, sort_order: 0 }),
    update: { column: 'aging_threshold_days', value: () => 30 },
    remove: { mode: 'delete' },
    audit: 'none',
    description: 'Stage in the test pipeline.',
  },
  {
    kind: 'crud', key: 'opportunities', label: 'Opportunities', module: 'Opportunities', table: 'opportunities',
    orgColumn: 'org_id', dependsOn: ['contacts', 'pipelines', 'pipeline_stages'], tagColumn: 'name',
    build: (c) => ({
      org_id: c.orgId,
      contact_id: c.refs.contacts,
      pipeline_id: c.refs.pipelines,
      stage_id: c.refs.pipeline_stages,
      name: c.tag,
      source: 'healthcheck',
      status: 'open',
      value_amount: 0,
      currency: 'USD',
      created_by: c.userId,
    }),
    update: { column: 'value_amount', value: () => 1 },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Opportunity in the test pipeline for the test contact.',
  },
  // ── Projects ────────────────────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'project_pipelines', label: 'Project pipelines', module: 'Projects', table: 'project_pipelines',
    orgColumn: 'org_id', dependsOn: [], tagColumn: 'name',
    build: (c) => ({ org_id: c.orgId, name: c.tag, sort_order: 9999 }),
    update: { column: 'name', value: updated },
    remove: { mode: 'delete' },
    audit: 'none',
    description: 'Dedicated test project pipeline.',
  },
  {
    kind: 'crud', key: 'project_stages', label: 'Project stages', module: 'Projects', table: 'project_stages',
    orgColumn: 'org_id', dependsOn: ['project_pipelines'], tagColumn: 'name',
    build: (c) => ({ org_id: c.orgId, pipeline_id: c.refs.project_pipelines, name: c.tag, sort_order: 0 }),
    update: { column: 'sla_days', value: () => 7 },
    remove: { mode: 'delete' },
    audit: 'none',
    description: 'Stage in the test project pipeline.',
  },
  {
    kind: 'crud', key: 'projects', label: 'Projects', module: 'Projects', table: 'projects',
    orgColumn: 'org_id', dependsOn: ['contacts', 'project_pipelines', 'project_stages'], tagColumn: 'name',
    build: (c) => ({
      org_id: c.orgId,
      contact_id: c.refs.contacts,
      pipeline_id: c.refs.project_pipelines,
      stage_id: c.refs.project_stages,
      name: c.tag,
      status: 'on_hold',
      priority: 'low',
      created_by: c.userId,
    }),
    update: { column: 'progress_percent', value: () => 10 },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'On-hold project in the test project pipeline.',
  },
  {
    kind: 'crud', key: 'project_tasks', label: 'Project tasks', module: 'Projects', table: 'project_tasks',
    orgColumn: 'org_id', dependsOn: ['projects'], tagColumn: 'title',
    build: (c) => ({
      org_id: c.orgId, project_id: c.refs.projects, title: c.tag, status: 'todo', priority: 'low', created_by: c.userId,
    }),
    update: { column: 'status', value: () => 'in_progress' },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Unassigned task on the test project.',
  },
  {
    kind: 'crud', key: 'project_files', label: 'Files (metadata)', module: 'Documents & Files', table: 'project_files',
    orgColumn: 'org_id', dependsOn: ['projects'], tagColumn: 'file_name',
    build: (c) => ({
      org_id: c.orgId,
      project_id: c.refs.projects,
      file_name: `${c.tag}.txt`,
      mime_type: 'text/plain',
      size_bytes: 0,
      uploaded_by: c.userId,
      note: 'System Health metadata-only row (no file in storage or Drive)',
    }),
    update: { column: 'note', value: updated },
    remove: { mode: 'delete' },
    audit: 'none',
    description: 'File metadata row only; nothing is uploaded.',
  },
  // ── Proposals / contracts ───────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'proposals', label: 'Proposals', module: 'Proposals', table: 'proposals',
    orgColumn: 'org_id', dependsOn: ['contacts'], tagColumn: 'title',
    build: (c) => ({
      org_id: c.orgId, contact_id: c.refs.contacts, title: c.tag, status: 'draft', currency: 'USD', created_by: c.userId,
    }),
    update: { column: 'summary', value: updated },
    remove: { mode: 'archive', patch: (c) => ({ archived_at: c.nowIso }), verifyColumn: 'archived_at' },
    audit: 'app',
    description: 'Draft proposal; archived via archived_at like the app.',
  },
  {
    kind: 'crud', key: 'contracts', label: 'Contracts', module: 'Contracts', table: 'contracts',
    orgColumn: 'org_id', dependsOn: ['proposals', 'contacts'], tagColumn: 'title',
    build: (c) => ({
      org_id: c.orgId,
      proposal_id: c.refs.proposals,
      contact_id: c.refs.contacts,
      title: c.tag,
      status: 'draft',
      created_by: c.userId,
    }),
    update: { column: 'custom_instructions', value: updated },
    remove: { mode: 'archive', patch: (c) => ({ archived_at: c.nowIso }), verifyColumn: 'archived_at' },
    audit: 'app',
    description: 'Draft contract; archived via archived_at like the app.',
  },
  // ── Conversations ───────────────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'conversations', label: 'Conversations', module: 'Conversations', table: 'conversations',
    orgColumn: 'organization_id', dependsOn: ['contacts'], tagColumn: 'external_thread_id',
    build: (c) => ({
      organization_id: c.orgId, contact_id: c.refs.contacts, status: 'closed', external_thread_id: c.tag,
    }),
    update: { column: 'conversation_metadata', value: (c) => ({ healthcheck: c.runId }) },
    remove: { mode: 'delete' },
    audit: 'none',
    description: 'Closed conversation on the test contact.',
  },
  {
    kind: 'crud', key: 'messages', label: 'Messages', module: 'Conversations', table: 'messages',
    orgColumn: 'organization_id', dependsOn: ['conversations', 'contacts'], tagColumn: 'body',
    build: (c) => ({
      organization_id: c.orgId,
      conversation_id: c.refs.conversations,
      contact_id: c.refs.contacts,
      channel: 'email',
      direction: 'system', // never 'outbound' (a sender could pick it up) or 'inbound' (notifies admins)
      status: 'sent',
      subject: c.tag,
      body: c.tag,
    }),
    update: { column: 'subject', value: updated },
    remove: {
      mode: 'archive',
      patch: (c) => ({ hidden_at: c.nowIso, hidden_by_user_id: c.userId }),
      verifyColumn: 'hidden_at',
    },
    audit: 'app',
    description: 'System message; hidden via hidden_at like the app.',
  },
  // ── Calendars ───────────────────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'calendars', label: 'Calendars', module: 'Calendars', table: 'calendars',
    orgColumn: 'org_id', dependsOn: [], tagColumn: 'name',
    build: (c) => ({ org_id: c.orgId, type: 'team', name: c.tag, slug: c.slug, active: false }),
    update: { column: 'description', value: updated },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Inactive team calendar (not bookable).',
  },
  {
    kind: 'crud', key: 'appointment_types', label: 'Appointment types', module: 'Calendars', table: 'appointment_types',
    orgColumn: 'org_id', dependsOn: ['calendars'], tagColumn: 'name',
    build: (c) => ({
      org_id: c.orgId, calendar_id: c.refs.calendars, name: c.tag, slug: c.slug, duration_minutes: 30, active: false,
    }),
    update: { column: 'description', value: updated },
    remove: { mode: 'delete' },
    audit: 'none',
    description: 'Inactive appointment type on the test calendar.',
  },
  {
    kind: 'crud', key: 'appointments', label: 'Appointments', module: 'Calendars', table: 'appointments',
    orgColumn: 'org_id', dependsOn: ['calendars', 'appointment_types', 'contacts'], tagColumn: 'notes',
    build: (c) => ({
      org_id: c.orgId,
      calendar_id: c.refs.calendars,
      appointment_type_id: c.refs.appointment_types,
      contact_id: c.refs.contacts,
      status: 'scheduled',
      source: 'manual',
      start_at_utc: FAR_FUTURE,
      end_at_utc: FAR_FUTURE_END,
      notes: c.tag,
    }),
    update: { column: 'internal_notes', value: updated },
    // Deleted rather than canceled: a status change to 'canceled' fires the appointment_cancelled
    // webhook trigger, and there is nothing a cancel would prove that the update did not.
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Appointment in 2099 so no reminder or confirmation cron sees it.',
  },
  // ── Forms / surveys / documents / meetings ──────────────────────────────────────────────────
  {
    kind: 'crud', key: 'forms', label: 'Forms', module: 'Forms & Surveys', table: 'forms',
    orgColumn: 'organization_id', dependsOn: [], tagColumn: 'name',
    build: (c) => ({ organization_id: c.orgId, name: c.tag, status: 'draft', definition: { fields: [] }, created_by: c.userId }),
    update: { column: 'description', value: updated },
    remove: { mode: 'archive', patch: () => ({ status: 'archived' }), verifyColumn: 'status' },
    audit: 'app',
    description: 'Draft form (no public slug); archived like the app.',
  },
  {
    kind: 'crud', key: 'surveys', label: 'Surveys', module: 'Forms & Surveys', table: 'surveys',
    orgColumn: 'organization_id', dependsOn: [], tagColumn: 'name',
    build: (c) => ({ organization_id: c.orgId, name: c.tag, status: 'draft', definition: { steps: [] }, created_by: c.userId }),
    update: { column: 'description', value: updated },
    remove: { mode: 'archive', patch: () => ({ status: 'archived' }), verifyColumn: 'status' },
    audit: 'app',
    description: 'Draft survey (no public slug); archived like the app.',
  },
  {
    kind: 'crud', key: 'documents', label: 'Documents', module: 'Documents & Files', table: 'documents',
    orgColumn: 'org_id', dependsOn: [], tagColumn: 'title',
    build: (c) => ({ org_id: c.orgId, title: c.tag, created_by: c.userId, updated_by: c.userId }),
    update: { column: 'title', value: updated },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Empty document.',
  },
  {
    kind: 'crud', key: 'meeting_transcriptions', label: 'Meeting transcriptions', module: 'Meetings',
    table: 'meeting_transcriptions', orgColumn: 'org_id', dependsOn: [], tagColumn: 'meeting_title',
    build: (c) => ({
      org_id: c.orgId,
      meeting_source: 'manual',
      external_meeting_id: c.slug,
      meeting_title: c.tag,
      meeting_date: c.nowIso,
      duration_minutes: 0,
      participants: [],
      transcript_text: 'System Health test row',
      imported_by: c.userId,
    }),
    update: { column: 'summary', value: updated },
    remove: { mode: 'delete' },
    audit: 'app',
    description: 'Manual transcription with no contact links.',
  },
  // ── Agents ──────────────────────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'agent_task_schedules', label: 'Agent task schedules', module: 'Agents',
    table: 'agent_task_schedules', orgColumn: 'org_id', dependsOn: [], tagColumn: 'title',
    build: (c) => ({
      org_id: c.orgId,
      // Owned by the caller, mode 'off', due in 2099: claim_due_agent_task_runs() only claims
      // `agent_user_id = auth.uid() AND mode <> 'off'`, so no agent can ever pick this up.
      agent_user_id: c.userId,
      agent_slug: 'friday',
      // Per-run key: uq_agent_task_schedule_identity is (agent_user_id, task_key, subject_id).
      task_key: `system.healthcheck_crud_${c.runId}`,
      title: c.tag,
      cadence: 'monthly',
      day_of_month: 1,
      next_run_at: FAR_FUTURE,
      risk_tier: 'autonomous',
      output_kind: 'none',
      approval_required: false,
      mode: 'off',
      created_by_user_id: c.userId,
    }),
    update: { column: 'description', value: updated },
    remove: { mode: 'delete' },
    audit: 'app',
    description: "Schedule in mode 'off' owned by you, due 2099 — unclaimable.",
  },
  {
    kind: 'crud', key: 'agent_task_runs', label: 'Agent task runs', module: 'Agents', table: 'agent_task_runs',
    orgColumn: 'org_id', dependsOn: ['agent_task_schedules'], tagColumn: 'result_summary',
    build: (c) => ({
      org_id: c.orgId,
      schedule_id: c.refs.agent_task_schedules,
      agent_user_id: c.userId,
      scheduled_for: c.nowIso,
      status: 'completed',
      mode_at_run: 'shadow',
      lease_expires_at: c.nowIso,
      finished_at: c.nowIso,
      delivered_at: c.nowIso,
      result_summary: c.tag,
    }),
    update: { column: 'result_summary', value: updated },
    remove: { mode: 'delete' },
    audit: 'none',
    rlsDeny: ['delete'],
    description: 'Completed + delivered run on the test schedule (nothing to claim or deliver).',
  },
  {
    kind: 'crud', key: 'approvals', label: 'Approvals queue', module: 'Agents', table: 'workflow_approval_queue',
    orgColumn: 'org_id', dependsOn: ['agent_task_runs'], tagColumn: 'title',
    build: (c) => ({
      org_id: c.orgId,
      source: 'agent_run',
      agent_run_id: c.refs.agent_task_runs,
      action_type: 'healthcheck',
      status: 'superseded', // never 'pending_approval': no reminder cron, no approver notification
      title: c.tag,
      description: 'System Health test row',
    }),
    update: { column: 'description', value: updated },
    remove: { mode: 'delete' },
    audit: 'app',
    rlsDeny: ['delete'],
    description: "Superseded approval tied to the test run (no reminders, no notifications).",
  },
  // ── Audit log ───────────────────────────────────────────────────────────────────────────────
  {
    kind: 'crud', key: 'audit_logs', label: 'Audit logs', module: 'Audit', table: 'audit_logs',
    orgColumn: 'organization_id', dependsOn: [], tagColumn: 'action',
    build: (c) => ({
      organization_id: c.orgId,
      user_id: c.userId,
      action: c.tag,
      entity_type: 'system_health',
      after_state: { healthcheck: true, run_id: c.runId },
    }),
    update: null, // audit rows are append-only
    remove: { mode: 'delete' },
    audit: 'none',
    rlsDeny: ['delete'],
    createdColumn: 'timestamp',
    description: 'Append-only: insert + read; users must not be able to delete.',
  },
  // ── Read-only ───────────────────────────────────────────────────────────────────────────────
  {
    kind: 'read', key: 'users', label: 'Users', module: 'Users & Roles', table: 'users',
    orgColumn: 'organization_id', columns: 'id, email, role_id, status',
    description: 'Read-only: list users in the org.',
  },
  {
    kind: 'read', key: 'roles', label: 'Roles', module: 'Users & Roles', table: 'roles',
    orgColumn: null, columns: 'id, name',
    description: 'Read-only: list roles.',
  },
];

/**
 * Resolve the specs to run, in dependency order.
 *
 * `selected` (spec keys) is expanded with every transitive dependency, so asking for
 * "opportunities" also builds contacts, pipelines and stages. Order follows the registry, which is
 * already topological; a dependency that appears later than its dependent is a registry bug and
 * throws, as does an unknown key.
 */
export function resolveOrder(specs: EntitySpec[], selected?: string[] | null): EntitySpec[] {
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const index = new Map(specs.map((s, i) => [s.key, i]));
  for (const s of specs) {
    if (s.kind !== 'crud') continue;
    for (const d of s.dependsOn) {
      if (!byKey.has(d)) throw new Error(`registry: ${s.key} depends on unknown ${d}`);
      if ((index.get(d) ?? 0) > (index.get(s.key) ?? 0)) throw new Error(`registry: ${s.key} listed before its dependency ${d}`);
    }
  }
  if (!selected || selected.length === 0) return specs.slice();

  const want = new Set<string>();
  const visit = (key: string) => {
    const s = byKey.get(key);
    if (!s) throw new Error(`unknown entity: ${key}`);
    if (want.has(key)) return;
    want.add(key);
    if (s.kind === 'crud') s.dependsOn.forEach(visit);
  };
  selected.forEach(visit);
  return specs.filter((s) => want.has(s.key));
}

/** Check id for a spec, as used in results and the catalogue. */
export function crudCheckId(key: string): string {
  return `crud.${key}`;
}
