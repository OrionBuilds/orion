/**
 * system-health — Settings -> System -> System Health.
 *
 * SuperAdmin only. The caller's JWT is verified and the SuperAdmin role confirmed BEFORE any
 * service-role query runs; everything is scoped to the caller's active org (honouring the
 * SuperAdmin org pivot, same as get_user_org_id()).
 *
 * Actions (POST JSON):
 *   { action: "catalogue" }                         -> every check the page can show
 *   { action: "run", mode?, groups?, checks? }      -> run groups; persists to system_health_runs
 *        mode "service" (default): CRUD via service role (tests schema + constraints)
 *        mode "rls": CRUD via the caller's own JWT (tests RLS policies); cleanup is still service role
 *        checks: ["crud.<entity>"] limits the Data group to those entities (+ dependencies)
 *   { action: "agent_ping", agents? }               -> enqueue a tagged no-op schedule per agent
 *
 * Probes are read-only. CRUD writes only "[healthcheck] <run>"-tagged rows and always removes them.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import type {
  CheckGroup,
  CheckResult,
  HealthRunReport,
  RunMode,
  SystemHealthRequest,
} from "../_shared/system-health/types.ts";
import { CHECK_GROUPS } from "../_shared/system-health/types.ts";
import { ENTITY_SPECS, HEALTHCHECK_TAG_PREFIX } from "../_shared/system-health/crud-registry.ts";
import { runCrudSuite, sweepTagged } from "../_shared/system-health/crud-runner.ts";
import { type AgentIdentity, buildCatalogue, DEFAULT_AGENTS } from "../_shared/system-health/catalogue.ts";
import { scrubSecrets, summarize } from "../_shared/system-health/evaluate.ts";
import { supabaseCrudDb } from "./db.ts";
import { probeAgents, probeInfrastructure, probeIntegrations, type ProbeCtx, startAgentPings } from "./probes.ts";

const headers = { ...corsHeaders, "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

/** Rows older than this from a crashed run are swept at the start of every Data run. */
const STALE_SWEEP_MINUTES = 30;

function agentsFromEnv(): AgentIdentity[] {
  const raw = Deno.env.get("SYSTEM_HEALTH_AGENTS");
  if (!raw) return DEFAULT_AGENTS;
  try {
    const parsed = JSON.parse(raw) as AgentIdentity[];
    return Array.isArray(parsed) && parsed.every((a) => a.slug && a.email && a.label) ? parsed : DEFAULT_AGENTS;
  } catch {
    return DEFAULT_AGENTS;
  }
}

function groupFailure(group: CheckGroup, e: unknown): CheckResult {
  return {
    id: `${group}.error`, group, name: `${group} checks`, durationMs: 0, status: "fail",
    summary: "group crashed", error: scrubSecrets(e instanceof Error ? e.message : String(e)),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const admin = getSupabaseClient();

  // ── AuthN + AuthZ first. No service-role query below this line runs for a non-SuperAdmin. ──
  const user = await extractUserContext(req, admin);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!user.isSuperAdmin) return json({ error: "System Health is restricted to SuperAdmins" }, 403);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");

  let body: SystemHealthRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const agents = agentsFromEnv();
  if (body.action === "catalogue") return json({ catalogue: buildCatalogue(agents) });

  const runUuid = crypto.randomUUID();
  const tagId = runUuid.replace(/-/g, "").slice(0, 10);
  const probeCtx: ProbeCtx = {
    admin, orgId: user.orgId, userId: user.id, runId: tagId, supabaseUrl, anonKey, agents, previous: [], now: () => Date.now(),
  };

  if (body.action === "agent_ping") {
    const results = await startAgentPings(probeCtx, body.agents);
    return json({ results });
  }

  if (body.action !== "run") return json({ error: "unknown action" }, 400);

  const mode: RunMode = body.mode === "rls" ? "rls" : "service";
  const groups: CheckGroup[] = (body.groups?.length ? body.groups : CHECK_GROUPS).filter((g) => CHECK_GROUPS.includes(g));
  const crudKeys = (body.checks ?? []).filter((c) => c.startsWith("crud.") && c !== "crud.cleanup").map((c) => c.slice(5));
  const startedAt = new Date();

  // Previous run, for rate-style metrics (agent polls/min). Missing table -> no history, no error.
  if (groups.includes("agents")) {
    const { data: prev } = await admin.from("system_health_runs").select("results")
      .eq("org_id", user.orgId).contains("groups", ["agents"]).order("started_at", { ascending: false }).limit(1).maybeSingle();
    probeCtx.previous = (prev?.results as CheckResult[] | undefined) ?? [];
  }

  const runData = async (): Promise<CheckResult[]> => {
    // Refuse to write a single test row unless the side-effect guard (migration 20261029210000)
    // is live: without it a test contact would enqueue real workflow events and webhooks.
    const guard = await admin.rpc("healthcheck_is_test_contact", { p_contact: null });
    if (guard.error) {
      return [{
        id: "crud.guard", group: "data", name: "CRUD safety guard", durationMs: 0, status: "fail",
        summary: "CRUD checks not run: apply migration 20261029210000_system_health.sql first",
        error: guard.error.message,
      }];
    }
    const adminDb = supabaseCrudDb(admin);
    const db = mode === "rls"
      ? supabaseCrudDb(createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }))
      : adminDb;
    const stale = await sweepTagged(
      adminDb, ENTITY_SPECS, user.orgId, HEALTHCHECK_TAG_PREFIX,
      new Date(Date.now() - STALE_SWEEP_MINUTES * 60_000).toISOString(),
    );
    const { results, cleanup } = await runCrudSuite({
      specs: ENTITY_SPECS, selected: crudKeys, db, admin: adminDb, mode, orgId: user.orgId, userId: user.id, runId: tagId,
    });
    cleanup.details = { ...cleanup.details, staleRowsSwept: stale.deleted, staleSweepErrors: stale.errors };
    if (stale.errors.length && cleanup.status === "pass") {
      cleanup.status = "warn";
      cleanup.error = stale.errors.join("; ");
    }
    return [...results, cleanup];
  };

  const runners: Record<CheckGroup, () => Promise<CheckResult[]>> = {
    data: runData,
    integrations: () => probeIntegrations(probeCtx),
    infrastructure: () => probeInfrastructure(probeCtx),
    agents: () => probeAgents(probeCtx),
  };

  const settled = await Promise.all(groups.map(async (g) => {
    try {
      return await runners[g]();
    } catch (e) {
      return [groupFailure(g, e)];
    }
  }));
  const results = settled.flat();

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const historyCheck: CheckResult = {
    id: "infra.history", group: "infrastructure", name: "Run history table", durationMs: 0, status: "pass", summary: "run saved",
  };
  const withHistory = groups.includes("infrastructure") ? [...results, historyCheck] : results;
  let { summary, status } = summarize(withHistory);

  const { error: histErr } = await admin.from("system_health_runs").insert({
    id: runUuid,
    org_id: user.orgId,
    triggered_by: user.id,
    mode,
    groups,
    status,
    pass_count: summary.pass,
    warn_count: summary.warn,
    fail_count: summary.fail,
    skip_count: summary.skip,
    results: withHistory,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
  });
  if (histErr) {
    historyCheck.status = "fail";
    historyCheck.summary = /does not exist|schema cache/i.test(histErr.message)
      ? "system_health_runs missing — apply migration 20261029210000_system_health.sql"
      : "could not save run";
    historyCheck.error = histErr.message;
    if (!groups.includes("infrastructure")) withHistory.push(historyCheck);
    ({ summary, status } = summarize(withHistory));
  }

  // One permanent audit row per run: who ran what, and the outcome.
  await admin.from("audit_logs").insert({
    organization_id: user.orgId,
    user_id: user.id,
    action: "system_health.run",
    entity_type: "system_health",
    entity_id: runUuid,
    after_state: { mode, groups, status, summary, checks: body.checks ?? null },
  });

  const report: HealthRunReport = {
    runId: runUuid,
    orgId: user.orgId,
    mode,
    groups,
    status,
    summary,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    results: withHistory,
    historySaved: !histErr,
  };
  return json(report);
});
