import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ReportExport {
  id: string;
  organization_id: string;
  report_run_id: string;
  status: string;
}

interface ReportRun {
  id: string;
  report_id: string;
  report: {
    data_source: string;
    config: Record<string, unknown>;
  };
}

function escapeCSVValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const stringValue = String(value);
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function generateCSV(columns: Array<{ key: string; label: string }>, rows: Array<Record<string, unknown>>): string {
  const header = columns.map(col => escapeCSVValue(col.label)).join(',');
  const dataRows = rows.map(row =>
    columns.map(col => escapeCSVValue(row[col.key])).join(',')
  );
  return [header, ...dataRows].join('\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: exports, error: fetchError } = await supabase
      .from('report_exports')
      .select(`
        id,
        organization_id,
        report_run_id,
        status
      `)
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1);

    if (fetchError) {
      throw new Error(`Failed to fetch exports: ${fetchError.message}`);
    }

    if (!exports || exports.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No queued exports' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const exportJob = exports[0] as ReportExport;

    await supabase
      .from('report_exports')
      .update({ status: 'running' })
      .eq('id', exportJob.id);

    const { data: runData, error: runError } = await supabase
      .from('report_runs')
      .select(`
        id,
        report_id,
        report:reports(data_source, config)
      `)
      .eq('id', exportJob.report_run_id)
      .single();

    if (runError || !runData) {
      throw new Error(`Failed to fetch report run: ${runError?.message}`);
    }

    const reportRun = runData as unknown as ReportRun;
    const report = reportRun.report;

    const { data: queryResult, error: queryError } = await supabase.rpc('execute_report_query', {
      query_text: buildExportQuery(report.data_source, report.config, exportJob.organization_id),
      query_params: [],
    });

    if (queryError) {
      throw new Error(`Query execution failed: ${queryError.message}`);
    }

    const config = report.config as {
      dimensions: Array<{ id: string; label: string }>;
      metrics: Array<{ id: string; label: string }>;
    };

    const columns = [
      ...config.dimensions.map(d => ({ key: d.id, label: d.label })),
      ...config.metrics.map(m => ({ key: m.id, label: m.label })),
    ];

    const csvContent = generateCSV(columns, queryResult || []);
    const csvBuffer = new TextEncoder().encode(csvContent);

    const filePath = `${exportJob.organization_id}/${exportJob.id}.csv`;

    const { error: uploadError } = await supabase.storage
      .from('report-exports')
      .upload(filePath, csvBuffer, {
        contentType: 'text/csv',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload CSV: ${uploadError.message}`);
    }

    await supabase
      .from('report_exports')
      .update({
        status: 'complete',
        file_path: filePath,
        file_size: csvBuffer.length,
        completed_at: new Date().toISOString(),
      })
      .eq('id', exportJob.id);

    await supabase
      .from('report_runs')
      .update({
        status: 'success',
        row_count: queryResult?.length || 0,
        finished_at: new Date().toISOString(),
      })
      .eq('id', exportJob.report_run_id);

    return new Response(
      JSON.stringify({
        success: true,
        exportId: exportJob.id,
        rowCount: queryResult?.length || 0,
        fileSize: csvBuffer.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Export worker error:', error);

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function buildExportQuery(
  dataSource: string,
  config: Record<string, unknown>,
  organizationId: string
): string {
  // Every identifier below reaches execute_report_query, which is SECURITY DEFINER owned by
  // postgres - it runs the text as superuser with RLS bypassed. Interpolating caller-controlled
  // values into it was arbitrary SQL execution: `dataSource` fell through to a raw table name when
  // unknown, and dim.field / metric.field / dim.id / dateGrouping / sort field+direction / limit
  // were all injected verbatim. A report config is user-authored, so this was reachable by saving
  // a crafted report and running an export.
  //
  // Nothing is interpolated now unless it appears in this allowlist. Column lists mirror the live
  // schema; the org column genuinely differs per table (appointments uses org_id, the rest
  // organization_id) - the old code hardcoded organization_id, which also meant that source
  // errored instead of being scoped. (The workflow_enrollments source was removed with the
  // retired workflow engine.)
  const SOURCES: Record<string, { table: string; orgColumn: string; columns: Set<string> }> = {
    contacts: { table: 'contacts', orgColumn: 'organization_id', columns: new Set('id,organization_id,department_id,owner_id,first_name,last_name,email,phone,company,job_title,address_line1,address_line2,city,state,postal_code,country,source,status,merged_into_contact_id,merged_at,merged_by_user_id,created_at,updated_at,created_by_user_id,dnc,last_activity_at,lead_score,stripe_customer_id,ghl_contact_id'.split(',')) },
    conversations: { table: 'conversations', orgColumn: 'organization_id', columns: new Set('id,organization_id,contact_id,assigned_user_id,department_id,status,last_message_at,unread_count,created_at,updated_at,external_thread_id,external_account_id,channel,provider,external_call_id,external_session_id,external_assistant_id,external_binding_id,conversation_metadata'.split(',')) },
    appointments: { table: 'appointments', orgColumn: 'org_id', columns: new Set('id,org_id,calendar_id,appointment_type_id,contact_id,assigned_user_id,status,start_at_utc,end_at_utc,visitor_timezone,answers,source,google_meet_link,reschedule_token,cancel_token,notes,history,created_at,updated_at,canceled_at,internal_notes,location,google_event_id,ghl_appointment_id'.split(',')) },
    forms: { table: 'form_submissions', orgColumn: 'organization_id', columns: new Set('id,organization_id,form_id,contact_id,payload,attribution,processed_status,error,idempotency_key,submitted_at'.split(',')) },
    surveys: { table: 'survey_submissions', orgColumn: 'organization_id', columns: new Set('id,organization_id,survey_id,contact_id,answers,score_total,score_band,attribution,processed_status,error,idempotency_key,submitted_at'.split(',')) },
  };

  const source = SOURCES[dataSource];
  if (!source) throw new Error(`Unsupported data source: ${dataSource}`);

  const DATE_GROUPINGS = new Set(['day', 'week', 'month', 'quarter', 'year']);
  const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /** A column that actually exists on this table, or reject. */
  const col = (f: unknown): string => {
    const v = String(f ?? '');
    if (!source.columns.has(v)) throw new Error(`Unknown field for ${dataSource}: ${v}`);
    return v;
  };
  /** An output alias - quoted, so restrict to a plain identifier. */
  const outAlias = (a: unknown): string => {
    const v = String(a ?? '');
    if (!ALIAS_RE.test(v)) throw new Error(`Invalid output alias: ${v}`);
    return v;
  };
  /** Single-quoted literal: escape embedded quotes. */
  const lit = (s: unknown): string => String(s ?? '').replace(/'/g, "''");

  const baseTable = source.table;
  const alias = 't';

  const typedConfig = config as {
    dimensions: Array<{ id: string; field: string; dataType: string; dateGrouping?: string }>;
    metrics: Array<{ id: string; field: string; aggregation: string }>;
    filters: Array<{ field: string; operator: string; value: unknown }>;
    timeRange: { type: string; preset?: string; customStart?: string; customEnd?: string };
    sorting: Array<{ field: string; direction: string }>;
    limit?: number;
  };

  const selectClauses: string[] = [];
  const groupByClauses: string[] = [];

  (typedConfig.dimensions ?? []).forEach(dim => {
    const field = col(dim.field);
    const id = outAlias(dim.id);
    if (dim.dataType === 'date' && dim.dateGrouping) {
      if (!DATE_GROUPINGS.has(dim.dateGrouping)) {
        throw new Error(`Invalid dateGrouping: ${dim.dateGrouping}`);
      }
      selectClauses.push(`DATE_TRUNC('${dim.dateGrouping}', ${alias}.${field}) AS "${id}"`);
      groupByClauses.push(`DATE_TRUNC('${dim.dateGrouping}', ${alias}.${field})`);
    } else {
      selectClauses.push(`${alias}.${field} AS "${id}"`);
      groupByClauses.push(`${alias}.${field}`);
    }
  });

  const AGGREGATIONS: Record<string, (c: string) => string> = {
    count: (c) => `COUNT(${c})`,
    count_distinct: (c) => `COUNT(DISTINCT ${c})`,
    sum: (c) => `COALESCE(SUM(${c}), 0)`,
    avg: (c) => `COALESCE(AVG(${c}), 0)`,
    min: (c) => `MIN(${c})`,
    max: (c) => `MAX(${c})`,
  };

  (typedConfig.metrics ?? []).forEach(metric => {
    const id = outAlias(metric.id);
    if (typeof metric.field === 'string' && metric.field.startsWith('status_')) {
      // Counts rows with a given status. The value is a literal, so escape it rather than
      // trusting it as an identifier.
      if (!source.columns.has('status')) throw new Error(`${dataSource} has no status column`);
      selectClauses.push(`COUNT(CASE WHEN ${alias}.status = '${lit(metric.field.slice('status_'.length))}' THEN 1 END) AS "${id}"`);
      return;
    }
    const field = col(metric.field);
    const agg = AGGREGATIONS[metric.aggregation] ?? AGGREGATIONS.count;
    selectClauses.push(`${agg(`${alias}.${field}`)} AS "${id}"`);
  });

  // Tenant scope. The org column name differs per table - see SOURCES above.
  const whereClauses = [`${alias}.${source.orgColumn} = '${lit(organizationId)}'`];

  let orderByClause = '';
  if (typedConfig.sorting?.length > 0) {
    const sortClauses = typedConfig.sorting.map(s => {
      const dir = String(s.direction ?? '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      // Sorting targets an output alias, which must be one we emitted.
      return `"${outAlias(s.field)}" ${dir}`;
    });
    orderByClause = `ORDER BY ${sortClauses.join(', ')}`;
  }

  // Must be a bounded integer - it is interpolated directly into LIMIT.
  const rawLimit = Number(typedConfig.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 100000 ? rawLimit : 100000;

  return `
    SELECT ${selectClauses.join(', ')}
    FROM ${baseTable} ${alias}
    WHERE ${whereClauses.join(' AND ')}
    ${groupByClauses.length > 0 ? `GROUP BY ${groupByClauses.join(', ')}` : ''}
    ${orderByClause}
    LIMIT ${limit}
  `.trim();
}
