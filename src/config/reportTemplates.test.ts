import { describe, expect, it } from 'vitest';
import {
  REPORT_ALLOWED_TABLES,
  REPORT_DATA_SOURCES,
  assertReportSqlAllowed,
  findReferencedTables,
} from '../../supabase/functions/_shared/report-sources';
import { REPORT_TEMPLATES, getAvailableReportTemplates } from './reportTemplates';
import { documentsTabs, navigationConfig, organizationTabs } from './navigation';

const knownFlags = new Set(
  [
    ...navigationConfig.flatMap((section) => section.items),
    ...documentsTabs,
    ...organizationTabs,
  ]
    .map((entry) => entry.featureFlag)
    .filter((flag): flag is string => Boolean(flag)),
);

describe('report templates', () => {
  it('only use tables the report engine is allowed to query', () => {
    for (const template of REPORT_TEMPLATES) {
      const missing = template.tables.filter((t) => !REPORT_ALLOWED_TABLES.has(t));
      expect(missing, `${template.id} needs tables the engine cannot read`).toEqual([]);
      expect(template.tables.length, `${template.id} lists no tables`).toBeGreaterThan(0);
    }
  });

  it('have unique ids and labels and a prompt', () => {
    const ids = REPORT_TEMPLATES.map((t) => t.id);
    const labels = REPORT_TEMPLATES.map((t) => t.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const t of REPORT_TEMPLATES) expect(t.prompt.length).toBeGreaterThan(t.label.length);
  });

  it('gate on feature flags that exist in the app', () => {
    for (const template of REPORT_TEMPLATES) {
      for (const flag of template.featureFlags) {
        expect(knownFlags.has(flag), `${template.id} uses unknown flag ${flag}`).toBe(true);
      }
    }
  });

  it('do not offer retired revenue or marketing reports', () => {
    for (const template of REPORT_TEMPLATES) {
      for (const table of ['invoices', 'payments', 'form_submissions', 'workflow_enrollments']) {
        expect(template.tables).not.toContain(table);
      }
    }
  });

  it('do not hard-code a period that would fight the range dropdown', () => {
    const datePhrase = /\b(last|this|next) (7|30|90)?\s*(days?|week|month|quarter|year)\b/i;
    for (const t of REPORT_TEMPLATES) expect(t.prompt).not.toMatch(datePhrase);
  });

  it('hide a template when one of its modules is disabled', () => {
    const enabled = new Set(['projects', 'opportunities']);
    const ids = getAvailableReportTemplates((flag) => enabled.has(flag)).map((t) => t.id);
    expect(ids).toContain('project-status-by-client');
    expect(ids).toContain('pipeline-value-by-stage');
    expect(ids).toContain('meetings-per-client'); // no flag required
    expect(ids).not.toContain('agent-run-outcomes');
    expect(ids).not.toContain('proposals-contracts-signed');
    expect(ids).not.toContain('government-opportunities');
  });
});

describe('report SQL guard (ai-report-generate)', () => {
  const org = "'{{ORG_ID}}'";

  it('lists one data source per table', () => {
    const tables = REPORT_DATA_SOURCES.map((ds) => ds.table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('accepts the queries the templates need', () => {
    const queries = [
      `SELECT ps.name AS stage, COUNT(*) AS deals, SUM(o.value_amount) AS value FROM public.opportunities o JOIN public.pipeline_stages ps ON ps.id = o.stage_id WHERE o.org_id = ${org} AND o.status = 'open' GROUP BY ps.name, ps.sort_order ORDER BY ps.sort_order LIMIT 25`,
      `SELECT COALESCE(NULLIF(c.company, ''), c.first_name || ' ' || c.last_name) AS client, COUNT(*) AS meetings, SUM(jsonb_array_length(m.action_items)) AS action_items FROM public.meeting_transcriptions m LEFT JOIN public.contacts c ON c.id = m.contact_id WHERE m.org_id = ${org} GROUP BY 1 LIMIT 25`,
      `SELECT s.title, r.status, COUNT(*) FROM public.agent_task_runs r JOIN public.agent_task_schedules s ON s.id = r.schedule_id WHERE r.org_id = ${org} GROUP BY 1, 2`,
      `SELECT u.name, COUNT(*) FILTER (WHERE t.due_date < CURRENT_DATE) AS overdue FROM public.project_tasks t LEFT JOIN public.users u ON u.id = t.assigned_user_id WHERE public.project_tasks.org_id = ${org} GROUP BY u.name`,
    ];
    for (const sql of queries) expect(() => assertReportSqlAllowed(sql)).not.toThrow();
  });

  it('finds schema-qualified tables, including quoted and three-part names', () => {
    expect(findReferencedTables(`SELECT 1 FROM "public"."projects" p WHERE public.projects.org_id = ${org}`)).toEqual(['projects']);
  });

  it('rejects tables outside the data sources', () => {
    expect(() => assertReportSqlAllowed(`SELECT COUNT(*) FROM public.integration_secrets`)).toThrow(/outside the report data sources/);
    expect(() => assertReportSqlAllowed(`SELECT COUNT(*) FROM public.projects p, public.org_api_keys k`)).toThrow(/org_api_keys/);
  });

  it('rejects system schemas and admin functions', () => {
    for (const sql of [
      'SELECT email, encrypted_password FROM auth.users',
      'SELECT * FROM "auth".users',
      'SELECT decrypted_secret FROM vault.decrypted_secrets',
      'SELECT table_name FROM information_schema.tables',
      'SELECT usename FROM pg_user',
      `SELECT pg_sleep(30), COUNT(*) FROM public.projects WHERE org_id = ${org}`,
      'SELECT * FROM U&"\\0061uth".users',
    ]) {
      expect(() => assertReportSqlAllowed(sql), sql).toThrow();
    }
  });

  it('requires at least one public table', () => {
    expect(() => assertReportSqlAllowed('SELECT 1')).toThrow(/at least one/);
  });
});
