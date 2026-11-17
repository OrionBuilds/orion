import { describe, expect, it } from 'vitest';
import {
  ENTITY_SPECS,
  HEALTHCHECK_TAG_PREFIX,
  type BuildCtx,
  type CrudSpec,
  makeTag,
  resolveOrder,
} from '../../../supabase/functions/_shared/system-health/crud-registry';
import { buildCatalogue } from '../../../supabase/functions/_shared/system-health/catalogue';

/**
 * Live columns of every table the registry writes (information_schema of the production project,
 * 2026-10-29). If a migration renames a column, update both this map and the registry; the test
 * exists because the previous check inserted contacts.created_by, which never existed.
 */
const LIVE_COLUMNS: Record<string, string[]> = {
  contacts: ['id', 'organization_id', 'department_id', 'owner_id', 'first_name', 'last_name', 'email', 'phone', 'company', 'job_title', 'source', 'status', 'created_by_user_id', 'dnc', 'lead_score'],
  contact_notes: ['id', 'contact_id', 'user_id', 'content', 'is_pinned', 'title', 'source_type', 'source_id', 'metadata'],
  contact_tasks: ['id', 'contact_id', 'assigned_to_user_id', 'created_by_user_id', 'title', 'description', 'due_date', 'priority', 'status'],
  custom_fields: ['id', 'organization_id', 'name', 'field_key', 'field_type', 'options', 'scope', 'help_text', 'visible_in_forms', 'visible_in_surveys', 'active', 'deleted_at'],
  contact_custom_field_values: ['id', 'contact_id', 'custom_field_id', 'value'],
  custom_object_definitions: ['id', 'organization_id', 'slug', 'name', 'icon', 'primary_field_key', 'field_definitions', 'is_builtin', 'active', 'deleted_at'],
  custom_object_records: ['id', 'organization_id', 'object_def_id', 'contact_id', 'primary_value', 'values', 'deleted_at'],
  pipelines: ['id', 'org_id', 'name', 'department_id', 'sort_order', 'owner_agent'],
  pipeline_stages: ['id', 'org_id', 'pipeline_id', 'name', 'sort_order', 'aging_threshold_days'],
  opportunities: ['id', 'org_id', 'contact_id', 'pipeline_id', 'stage_id', 'assigned_user_id', 'value_amount', 'currency', 'status', 'source', 'created_by', 'name', 'description'],
  project_pipelines: ['id', 'org_id', 'name', 'sort_order', 'owner_agent'],
  project_stages: ['id', 'org_id', 'pipeline_id', 'name', 'sort_order', 'sla_days', 'color'],
  projects: ['id', 'org_id', 'contact_id', 'pipeline_id', 'stage_id', 'name', 'description', 'status', 'priority', 'progress_percent', 'created_by'],
  project_tasks: ['id', 'org_id', 'project_id', 'title', 'description', 'status', 'priority', 'created_by'],
  project_files: ['id', 'org_id', 'project_id', 'file_name', 'mime_type', 'size_bytes', 'uploaded_by', 'note'],
  proposals: ['id', 'org_id', 'contact_id', 'title', 'status', 'summary', 'currency', 'created_by', 'archived_at'],
  contracts: ['id', 'org_id', 'proposal_id', 'contact_id', 'title', 'status', 'created_by', 'custom_instructions', 'archived_at'],
  conversations: ['id', 'organization_id', 'contact_id', 'status', 'external_thread_id', 'conversation_metadata'],
  messages: ['id', 'organization_id', 'conversation_id', 'contact_id', 'channel', 'direction', 'body', 'subject', 'status', 'hidden_at', 'hidden_by_user_id'],
  calendars: ['id', 'org_id', 'type', 'name', 'slug', 'owner_user_id', 'active', 'description'],
  appointment_types: ['id', 'org_id', 'calendar_id', 'name', 'slug', 'description', 'duration_minutes', 'active'],
  appointments: ['id', 'org_id', 'calendar_id', 'appointment_type_id', 'contact_id', 'status', 'start_at_utc', 'end_at_utc', 'source', 'notes', 'internal_notes', 'canceled_at'],
  forms: ['id', 'organization_id', 'name', 'description', 'status', 'definition', 'created_by'],
  surveys: ['id', 'organization_id', 'name', 'description', 'status', 'definition', 'created_by'],
  documents: ['id', 'org_id', 'title', 'created_by', 'updated_by'],
  meeting_transcriptions: ['id', 'org_id', 'meeting_source', 'external_meeting_id', 'meeting_title', 'meeting_date', 'duration_minutes', 'participants', 'transcript_text', 'summary', 'imported_by'],
  agent_task_schedules: ['id', 'org_id', 'agent_user_id', 'agent_slug', 'task_key', 'title', 'description', 'cadence', 'day_of_month', 'next_run_at', 'risk_tier', 'output_kind', 'approval_required', 'mode', 'created_by_user_id'],
  agent_task_runs: ['id', 'org_id', 'schedule_id', 'agent_user_id', 'scheduled_for', 'status', 'mode_at_run', 'lease_expires_at', 'finished_at', 'delivered_at', 'result_summary'],
  workflow_approval_queue: ['id', 'org_id', 'source', 'agent_run_id', 'action_type', 'status', 'title', 'description'],
  audit_logs: ['id', 'organization_id', 'user_id', 'action', 'entity_type', 'entity_id', 'after_state', 'timestamp'],
  users: ['id', 'organization_id', 'email', 'role_id', 'status'],
  roles: ['id', 'name'],
};

const crudSpecs = ENTITY_SPECS.filter((s): s is CrudSpec => s.kind === 'crud');

function ctxWithRefs(): BuildCtx {
  const refs: Record<string, string> = {};
  ENTITY_SPECS.forEach((s, i) => { refs[s.key] = `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`; });
  return {
    orgId: 'org-1', userId: 'user-1', runId: 'abc123def0', tag: makeTag('abc123def0'), slug: 'healthcheck-abc123def0',
    refs, nowIso: '2026-10-29T00:00:00.000Z',
  };
}

describe('crud registry', () => {
  it('is in dependency order and every dependency exists', () => {
    expect(() => resolveOrder(ENTITY_SPECS)).not.toThrow();
  });

  it('writes only columns that exist on the live table', () => {
    const ctx = ctxWithRefs();
    for (const s of crudSpecs) {
      const cols = LIVE_COLUMNS[s.table];
      expect(cols, `no column list for ${s.table}`).toBeDefined();
      for (const k of Object.keys(s.build(ctx))) expect(cols, `${s.table}.${k}`).toContain(k);
      if (s.update) expect(cols, `${s.table}.${s.update.column}`).toContain(s.update.column);
      if (s.remove.mode === 'archive') {
        for (const k of Object.keys(s.remove.patch(ctx))) expect(cols, `${s.table}.${k}`).toContain(k);
      }
      if (s.tagColumn) expect(cols).toContain(s.tagColumn);
      if (s.orgColumn) expect(cols).toContain(s.orgColumn);
    }
    for (const s of ENTITY_SPECS.filter((x) => x.kind === 'read')) {
      if (s.kind !== 'read') continue;
      for (const c of s.columns.split(',').map((x) => x.trim())) expect(LIVE_COLUMNS[s.table]).toContain(c);
    }
  });

  it('never uses contacts.created_by (the column behind the old "schema cache" failure)', () => {
    const contacts = crudSpecs.find((s) => s.key === 'contacts')!;
    const row = contacts.build(ctxWithRefs());
    expect(row).not.toHaveProperty('created_by');
    expect(row.created_by_user_id).toBe('user-1');
  });

  it('tags every row and scopes it to the caller org', () => {
    const ctx = ctxWithRefs();
    for (const s of crudSpecs) {
      const row = s.build(ctx);
      if (s.tagColumn) expect(String(row[s.tagColumn]).startsWith(`${HEALTHCHECK_TAG_PREFIX} abc123def0`), s.key).toBe(true);
      if (s.orgColumn) expect(row[s.orgColumn], s.key).toBe('org-1');
      for (const d of s.dependsOn) expect(Object.values(row), `${s.key} uses ${d}`).toContain(ctx.refs[d]);
    }
  });

  it('keeps tagged values tagged after update so a crashed run is still sweepable', () => {
    const ctx = ctxWithRefs();
    for (const s of crudSpecs) {
      if (s.update && s.update.column === s.tagColumn) {
        expect(String(s.update.value(ctx)).startsWith(ctx.tag), s.key).toBe(true);
      }
    }
  });

  it('builds inert test rows that no cron, sender or agent will act on', () => {
    const ctx = ctxWithRefs();
    const row = (k: string) => crudSpecs.find((s) => s.key === k)!.build(ctx);
    expect(row('agent_task_schedules').mode).toBe('off');
    expect(row('agent_task_schedules').agent_user_id).toBe('user-1');
    expect(String(row('agent_task_schedules').next_run_at).startsWith('2099')).toBe(true);
    expect(row('agent_task_runs').status).toBe('completed');
    expect(row('approvals').status).not.toBe('pending_approval');
    expect(row('messages').direction).toBe('system');
    expect(String(row('appointments').start_at_utc).startsWith('2099')).toBe(true);
    expect(row('calendars').active).toBe(false);
    expect(row('appointment_types').active).toBe(false);
    expect(row('custom_fields').active).toBe(false);
    expect(row('proposals').status).toBe('draft');
    expect(row('contracts').status).toBe('draft');
    expect(row('forms').status).toBe('draft');
    expect(row('conversations').status).toBe('closed');
    expect(String(row('contacts').email).endsWith('.invalid')).toBe(true);
  });

  it('uses per-run unique keys where the table has a unique index', () => {
    const a = ctxWithRefs();
    const b = { ...a, runId: 'ffff000011', tag: makeTag('ffff000011'), slug: 'healthcheck-ffff000011' };
    const sched = crudSpecs.find((s) => s.key === 'agent_task_schedules')!;
    expect(sched.build(a).task_key).not.toBe(sched.build(b).task_key);
    for (const k of ['calendars', 'custom_object_definitions', 'meeting_transcriptions']) {
      const s = crudSpecs.find((x) => x.key === k)!;
      expect(JSON.stringify(s.build(a))).not.toBe(JSON.stringify(s.build(b)));
    }
  });

  it('expands selected entities with their dependencies, in order', () => {
    const keys = resolveOrder(ENTITY_SPECS, ['opportunities']).map((s) => s.key);
    expect(keys).toEqual(['contacts', 'pipelines', 'pipeline_stages', 'opportunities']);
    const approvals = resolveOrder(ENTITY_SPECS, ['approvals']).map((s) => s.key);
    expect(approvals).toEqual(['agent_task_schedules', 'agent_task_runs', 'approvals']);
  });

  it('rejects unknown entities', () => {
    expect(() => resolveOrder(ENTITY_SPECS, ['payments'])).toThrow(/unknown entity/);
  });

  it('catalogues every entity plus cleanup and the probe groups', () => {
    const cat = buildCatalogue();
    for (const s of ENTITY_SPECS) expect(cat.some((c) => c.id === `crud.${s.key}`)).toBe(true);
    expect(cat.some((c) => c.id === 'crud.cleanup')).toBe(true);
    for (const g of ['integrations', 'infrastructure', 'agents']) expect(cat.some((c) => c.group === g)).toBe(true);
    expect(new Set(cat.map((c) => c.id)).size).toBe(cat.length);
  });
});
