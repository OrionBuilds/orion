// Read-only health probes for the system-health function. Nothing here writes, except the agent
// ping (insert/delete of its own tagged schedule) and its cleanup, both clearly marked.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CheckGroup, CheckResult, CheckStatus } from "../_shared/system-health/types.ts";
import {
  ageMinutes,
  backlogStatus,
  cronJobStatus,
  type CronRow,
  edgeFunctionStatus,
  failureRateStatus,
  heartbeatStatus,
  oauthTokenStatus,
  pingOutcome,
  scrubSecrets,
} from "../_shared/system-health/evaluate.ts";
import {
  type AgentIdentity,
  EDGE_FUNCTION_PINGS,
  QUEUE_PROBES,
  type QueueProbe,
} from "../_shared/system-health/catalogue.ts";
import { HEALTHCHECK_TAG_PREFIX } from "../_shared/system-health/crud-registry.ts";
import { getTwilioAccount, getTwilioEnvCreds } from "../_shared/twilio.ts";
import { getResendEnvCreds, listResendDomains } from "../_shared/resend.ts";
import { openSecret } from "../_shared/secrets.ts";
import { decryptToken, isEncryptedToken } from "../_shared/crypto.ts";

export interface ProbeCtx {
  admin: SupabaseClient;
  orgId: string;
  userId: string;
  runId: string;
  supabaseUrl: string;
  anonKey: string;
  agents: AgentIdentity[];
  /** Results of the previous run (for rates such as polls/min). */
  previous: CheckResult[];
  now: () => number;
}

type ProbeOutcome = Omit<CheckResult, "id" | "group" | "name" | "durationMs">;

/** The slice of the PostgREST builder the queue probe chains (kept structural to avoid `any`). */
interface QueueQuery extends PromiseLike<{ data: unknown[] | null; count: number | null; error: { message: string } | null }> {
  eq(column: string, value: unknown): QueueQuery;
  in(column: string, values: unknown[]): QueueQuery;
  is(column: string, value: null): QueueQuery;
  lte(column: string, value: unknown): QueueQuery;
  order(column: string, opts: { ascending: boolean }): QueueQuery;
  limit(n: number): QueueQuery;
}

const PING_TIMEOUT_MIN = Number(Deno.env.get("SYSTEM_HEALTH_PING_TIMEOUT_MINUTES") ?? "10");

function errText(e: unknown): string {
  return scrubSecrets(e instanceof Error ? e.message : String(e));
}

async function check(
  id: string,
  group: CheckGroup,
  name: string,
  fn: () => Promise<ProbeOutcome>,
): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { id, group, name, durationMs: Date.now() - t0, ...r, error: r.error ? scrubSecrets(r.error) : undefined };
  } catch (e) {
    return { id, group, name, durationMs: Date.now() - t0, status: "fail", summary: "probe threw", error: errText(e) };
  }
}

async function fetchT(url: string, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

function isMissingRpc(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
}

const MIGRATION_HINT = "apply migration 20261029210000_system_health.sql";

// ── Infrastructure ────────────────────────────────────────────────────────────────────────────

export async function probeInfrastructure(ctx: ProbeCtx): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const [db, edge, cron, storage, meet, queues] = await Promise.all([
    probeDbLatency(ctx),
    probeEdgeFunctions(ctx),
    probeCron(ctx),
    probeStorage(ctx),
    probeMeetBacklog(ctx),
    probeQueues(ctx, "infrastructure"),
  ]);
  out.push(db, ...edge, ...cron, ...storage, meet, ...queues);
  return out;
}

function probeDbLatency(ctx: ProbeCtx): Promise<CheckResult> {
  return check("infra.db_latency", "infrastructure", "Database latency", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const { error } = await ctx.admin.from("organizations").select("id").eq("id", ctx.orgId).maybeSingle();
      if (error) return { status: "fail", summary: "query failed", error: error.message };
      samples.push(Math.round(performance.now() - t));
    }
    const median = [...samples].sort((a, b) => a - b)[1];
    const status: CheckStatus = median < 300 ? "pass" : median < 1000 ? "warn" : "fail";
    return { status, summary: `median ${median} ms (${samples.join(" / ")} ms)`, details: { samplesMs: samples, medianMs: median } };
  });
}

function probeEdgeFunctions(ctx: ProbeCtx): Promise<CheckResult[]> {
  return Promise.all(
    EDGE_FUNCTION_PINGS.map((fn) =>
      check(`infra.edge.${fn}`, "infrastructure", `Edge function: ${fn}`, async () => {
        const t = performance.now();
        let httpStatus: number | null = null;
        try {
          const res = await fetchT(`${ctx.supabaseUrl}/functions/v1/${fn}`, {
            method: "OPTIONS",
            headers: {
              apikey: ctx.anonKey,
              Authorization: `Bearer ${ctx.anonKey}`,
              Origin: "https://system-health.invalid",
              "Access-Control-Request-Method": "POST",
            },
          }, 8_000);
          httpStatus = res.status;
          await res.body?.cancel();
        } catch {
          httpStatus = null;
        }
        const ms = Math.round(performance.now() - t);
        const v = edgeFunctionStatus(httpStatus);
        return { status: v.status, summary: `${v.reason}, ${ms} ms`, details: { httpStatus, latencyMs: ms } };
      })
    ),
  );
}

async function probeCron(ctx: ProbeCtx): Promise<CheckResult[]> {
  const t0 = Date.now();
  const { data, error } = await ctx.admin.rpc("system_health_cron_status");
  if (error) {
    return [{
      id: "infra.cron", group: "infrastructure", name: "Cron jobs", durationMs: Date.now() - t0, status: "fail",
      summary: isMissingRpc(error) ? `RPC missing — ${MIGRATION_HINT}` : "cron status query failed",
      error: error.message,
    }];
  }
  const rows = (data ?? []) as Array<CronRow & { history_rows_estimate: number | null }>;
  const nowMs = ctx.now();
  const per: CheckResult[] = rows.map((r) => {
    const v = cronJobStatus(r, nowMs);
    return {
      id: `infra.cron.${r.jobname}`, group: "infrastructure", name: `Cron: ${r.jobname}`, durationMs: 0,
      status: v.status, summary: v.reason,
      error: v.status === "fail" || v.status === "warn" ? scrubSecrets(v.reason) : undefined,
      details: {
        schedule: r.schedule, active: r.active, lastStart: r.last_start, lastStatus: r.last_status,
        runs24h: r.runs_24h, failures24h: r.failures_24h,
      },
    };
  });
  const est = Number(rows[0]?.history_rows_estimate ?? 0);
  const failing = per.filter((p) => p.status === "fail").length;
  const overall: CheckResult = {
    id: "infra.cron", group: "infrastructure", name: "Cron jobs", durationMs: Date.now() - t0,
    status: failing ? "fail" : est > 1_000_000 ? "warn" : "pass",
    summary: `${rows.length} job(s), ${rows.filter((r) => r.active).length} active, ${failing} failing` +
      (est > 1_000_000 ? `; cron.job_run_details holds ~${(est / 1e6).toFixed(1)}M rows (never purged)` : ""),
    details: { jobs: rows.length, historyRowsEstimate: est },
  };
  return [overall, ...per];
}

async function probeStorage(ctx: ProbeCtx): Promise<CheckResult[]> {
  const t0 = Date.now();
  const { data: buckets, error } = await ctx.admin.storage.listBuckets();
  if (error) {
    return [{ id: "infra.storage", group: "infrastructure", name: "Storage buckets", durationMs: Date.now() - t0,
      status: "fail", summary: "listBuckets failed", error: error.message }];
  }
  return await Promise.all((buckets ?? []).map((b) =>
    check(`infra.storage.${b.id}`, "infrastructure", `Bucket: ${b.id}`, async () => {
      const { error: e } = await ctx.admin.storage.from(b.id).list("", { limit: 1 });
      if (e) return { status: "fail", summary: "list failed", error: e.message, details: { public: b.public } };
      return { status: "pass", summary: `reachable (${b.public ? "public" : "private"})`, details: { public: b.public } };
    })
  ));
}

function probeMeetBacklog(ctx: ProbeCtx): Promise<CheckResult> {
  return check("infra.meet_backlog", "infrastructure", "Meeting processing backlog", async () => {
    const nowMs = ctx.now();
    const twoHoursAgo = new Date(nowMs - 2 * 3600_000).toISOString();
    const weekAgo = new Date(nowMs - 7 * 24 * 3600_000).toISOString();
    const [gmeet, teams, trans, gFailed, tFailed] = await Promise.all([
      ctx.admin.from("google_meet_sessions").select("id, event_end_time", { count: "exact" })
        .eq("org_id", ctx.orgId).in("status", ["detected", "queued", "processing"]).lt("event_end_time", twoHoursAgo)
        .order("event_end_time", { ascending: true }).limit(1),
      ctx.admin.from("meeting_sessions").select("id, end_at", { count: "exact" })
        .eq("org_id", ctx.orgId).in("status", ["detected", "processing"]).lt("end_at", twoHoursAgo)
        .order("end_at", { ascending: true }).limit(1),
      ctx.admin.from("meeting_transcriptions").select("id, transcription_requested_at", { count: "exact" })
        .eq("org_id", ctx.orgId).in("transcription_status", ["queued", "processing"])
        .lt("transcription_requested_at", new Date(nowMs - 3600_000).toISOString())
        .order("transcription_requested_at", { ascending: true }).limit(1),
      ctx.admin.from("google_meet_sessions").select("id", { count: "exact", head: true })
        .eq("org_id", ctx.orgId).eq("status", "failed").gte("updated_at", weekAgo),
      ctx.admin.from("meeting_sessions").select("id", { count: "exact", head: true })
        .eq("org_id", ctx.orgId).eq("status", "failed").gte("updated_at", weekAgo),
    ]);
    const firstErr = [gmeet, teams, trans, gFailed, tFailed].find((r) => r.error)?.error;
    if (firstErr) return { status: "fail", summary: "backlog query failed", error: firstErr.message };
    const stuck = (gmeet.count ?? 0) + (teams.count ?? 0) + (trans.count ?? 0);
    const oldest = [
      (gmeet.data?.[0] as { event_end_time?: string } | undefined)?.event_end_time,
      (teams.data?.[0] as { end_at?: string } | undefined)?.end_at,
      (trans.data?.[0] as { transcription_requested_at?: string } | undefined)?.transcription_requested_at,
    ].filter(Boolean).sort()[0] ?? null;
    const oldestAge = ageMinutes(oldest, nowMs);
    const failed7d = (gFailed.count ?? 0) + (tFailed.count ?? 0);
    let status = backlogStatus(stuck, oldestAge, { warnAgeMin: 120, failAgeMin: 24 * 60 });
    if (status === "pass" && failed7d > 0) status = "warn";
    return {
      status,
      summary: stuck
        ? `${stuck} stuck (oldest ${oldestAge} min); ${failed7d} failed in 7d`
        : `nothing stuck; ${failed7d} failed in 7d`,
      details: { googleMeetStuck: gmeet.count ?? 0, teamsStuck: teams.count ?? 0, transcriptionsStuck: trans.count ?? 0, failed7d },
    };
  });
}

export function probeQueues(ctx: ProbeCtx, group: CheckGroup): Promise<CheckResult[]> {
  return Promise.all(QUEUE_PROBES.filter((q) => q.group === group).map((q) => probeQueue(ctx, q)));
}

function probeQueue(ctx: ProbeCtx, q: QueueProbe): Promise<CheckResult> {
  return check(q.id, q.group, q.label, async () => {
    const nowIso = new Date(ctx.now()).toISOString();
    const apply = (b: QueueQuery): QueueQuery => {
      let x = b.eq(q.orgColumn, ctx.orgId);
      for (const [col, op, raw] of q.filters) {
        const v = raw === "now" ? nowIso : raw;
        x = op === "eq" ? x.eq(col, v) : op === "in" ? x.in(col, v as unknown[]) : op === "is" ? x.is(col, null) : x.lte(col, v);
      }
      return x;
    };
    const countQ = ctx.admin.from(q.table).select("id", { count: "exact", head: true }) as unknown as QueueQuery;
    const oldestQ = ctx.admin.from(q.table).select(q.ageColumn) as unknown as QueueQuery;
    const [countRes, oldestRes] = await Promise.all([
      apply(countQ),
      apply(oldestQ).order(q.ageColumn, { ascending: true }).limit(1),
    ]);
    if (countRes.error) return { status: "fail", summary: "query failed", error: countRes.error.message };
    if (oldestRes.error) return { status: "fail", summary: "query failed", error: oldestRes.error.message };
    const pending = countRes.count ?? 0;
    const oldestIso = (oldestRes.data?.[0] as Record<string, string> | undefined)?.[q.ageColumn] ?? null;
    const age = ageMinutes(oldestIso, ctx.now());
    const status = backlogStatus(pending, age, { warnAgeMin: q.warnAgeMin, failAgeMin: q.failAgeMin });
    return {
      status,
      summary: pending ? `${pending} pending, oldest ${age} min` : "empty",
      error: status !== "pass" ? `oldest pending row waited ${age} min (warn ${q.warnAgeMin}, fail ${q.failAgeMin})` : undefined,
      details: { table: q.table, pending, oldestAgeMin: age },
    };
  });
}

// ── Integrations ──────────────────────────────────────────────────────────────────────────────

export async function probeIntegrations(ctx: ProbeCtx): Promise<CheckResult[]> {
  const parts = await Promise.all([
    probeGoogle(ctx),
    probeMicrosoft(ctx),
    probeTwilio(ctx),
    probeResend(),
    probeLlm(ctx, "anthropic"),
    probeLlm(ctx, "openai"),
    probeLlm(ctx, "gemini"),
    probeElevenLabs(ctx),
  ]);
  return parts.flat();
}

async function probeGoogle(ctx: ProbeCtx): Promise<CheckResult[]> {
  const t0 = Date.now();
  const { data, error } = await ctx.admin
    .from("google_oauth_master")
    .select("id, email, encrypted_access_token, token_expiry, refresh_fail_count, refresh_failed_at, granted_scopes, connection_status, is_primary")
    .eq("org_id", ctx.orgId);
  if (error) {
    return [{ id: "integrations.google", group: "integrations", name: "Google connections", durationMs: Date.now() - t0,
      status: "fail", summary: "lookup failed", error: error.message }];
  }
  if (!data?.length) {
    return [{ id: "integrations.google", group: "integrations", name: "Google connections", durationMs: Date.now() - t0,
      status: "skip", summary: "no Google accounts connected" }];
  }
  return await Promise.all(data.map((row) =>
    check(`integrations.google.${row.email ?? row.id}`, "integrations", `Google: ${row.email ?? "account"}`, async () => {
      const nowMs = ctx.now();
      const v = oauthTokenStatus({ expiresAt: row.token_expiry, refreshFailCount: row.refresh_fail_count, nowMs });
      const details: Record<string, unknown> = {
        tokenExpiry: row.token_expiry, refreshFailCount: row.refresh_fail_count ?? 0,
        scopes: Array.isArray(row.granted_scopes) ? row.granted_scopes.length : 0,
        connectionStatus: row.connection_status ?? "active", isPrimary: !!row.is_primary,
      };
      // one row per Google account: an account that needs re-authorization is reported on its own
      if (row.connection_status === "needs_reauth") {
        return { status: "fail", summary: "account needs to be reconnected", error: "connection_status needs_reauth", details };
      }
      // Live check only with a still-valid access token; never refresh from here.
      if (v.status === "pass" && row.encrypted_access_token && Date.parse(row.token_expiry) > nowMs + 30_000) {
        const token = isEncryptedToken(row.encrypted_access_token)
          ? await decryptToken(row.encrypted_access_token)
          : row.encrypted_access_token;
        const res = await fetchT("https://oauth2.googleapis.com/tokeninfo", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ access_token: token }),
        });
        details.tokeninfoStatus = res.status;
        await res.body?.cancel();
        if (!res.ok) return { status: "fail", summary: `Google rejected the stored access token (${res.status})`, error: `tokeninfo ${res.status}`, details };
        return { status: "pass", summary: "token valid (tokeninfo 200)", details };
      }
      return { status: v.status, summary: v.reason, error: v.status === "pass" ? undefined : v.reason, details };
    })
  ));
}

async function probeMicrosoft(ctx: ProbeCtx): Promise<CheckResult[]> {
  const t0 = Date.now();
  const { data, error } = await ctx.admin
    .from("microsoft_oauth_master")
    .select("id, email, encrypted_access_token, token_expires_at, connection_status, last_refresh_at, last_refresh_error")
    .eq("organization_id", ctx.orgId);
  if (error) {
    return [{ id: "integrations.microsoft", group: "integrations", name: "Microsoft connections", durationMs: Date.now() - t0,
      status: "fail", summary: "lookup failed", error: error.message }];
  }
  if (!data?.length) {
    return [{ id: "integrations.microsoft", group: "integrations", name: "Microsoft connections", durationMs: Date.now() - t0,
      status: "skip", summary: "no Microsoft accounts connected" }];
  }
  return await Promise.all(data.map((row) =>
    check(`integrations.microsoft.${row.email ?? row.id}`, "integrations", `Microsoft: ${row.email ?? "account"}`, async () => {
      const nowMs = ctx.now();
      const v = oauthTokenStatus({
        expiresAt: row.token_expires_at,
        needsReauth: row.connection_status === "needs_reauth",
        lastRefreshError: row.last_refresh_error,
        nowMs,
      });
      const details: Record<string, unknown> = {
        status: row.connection_status, tokenExpiresAt: row.token_expires_at, lastRefreshAt: row.last_refresh_at,
      };
      if (v.status === "pass" && row.encrypted_access_token && Date.parse(row.token_expires_at) > nowMs + 30_000) {
        const token = await decryptToken(row.encrypted_access_token);
        const res = await fetchT("https://graph.microsoft.com/v1.0/me?$select=id", { headers: { Authorization: `Bearer ${token}` } });
        details.graphStatus = res.status;
        await res.body?.cancel();
        if (!res.ok) return { status: "fail", summary: `Graph /me returned ${res.status}`, error: `graph ${res.status}`, details };
        return { status: "pass", summary: "token valid (Graph /me 200)", details };
      }
      return { status: v.status, summary: v.reason, error: v.status === "pass" ? undefined : v.reason, details };
    })
  ));
}

function probeTwilio(ctx: ProbeCtx): Promise<CheckResult> {
  return check("integrations.twilio", "integrations", "Twilio", async () => {
    const creds = getTwilioEnvCreds();
    const { data: conn } = await ctx.admin.from("twilio_connection").select("status, friendly_name").eq("org_id", ctx.orgId).maybeSingle();
    if (!creds) return { status: "fail", summary: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set", error: "missing env secrets" };
    const r = await getTwilioAccount(creds.accountSid, creds.authToken);
    const details = { httpStatus: r.status, accountStatus: r.account?.status, orgConnection: conn?.status ?? null };
    if (!r.ok) return { status: "fail", summary: `Twilio API ${r.status}`, error: r.error, details };
    if (r.account?.status !== "active") return { status: "fail", summary: `account ${r.account?.status}`, error: `account status ${r.account?.status}`, details };
    if (conn && conn.status !== "connected") return { status: "warn", summary: `account active; org connection ${conn.status}`, details };
    return { status: "pass", summary: `account active (${r.account?.friendly_name ?? "Twilio"})`, details };
  });
}

function probeResend(): Promise<CheckResult> {
  return check("integrations.resend", "integrations", "Resend", async () => {
    const creds = getResendEnvCreds();
    if (!creds) return { status: "fail", summary: "RESEND_API_KEY / RESEND_FROM_EMAIL not set", error: "missing env secrets" };
    const r = await listResendDomains(creds.apiKey);
    if (!r.ok) return { status: "fail", summary: "API key rejected", error: r.error };
    const fromDomain = creds.fromEmail.split("@")[1]?.toLowerCase() ?? "";
    const match = r.domains.find((d) => fromDomain === d.name.toLowerCase() || fromDomain.endsWith(`.${d.name.toLowerCase()}`));
    const details = { domains: r.domains.map((d) => ({ name: d.name, status: d.status })), fromDomain };
    if (!match) return { status: "fail", summary: `sender domain ${fromDomain} not in Resend`, error: "sender domain missing", details };
    if (match.status !== "verified") return { status: "fail", summary: `${match.name} is ${match.status}`, error: `domain ${match.status}`, details };
    return { status: "pass", summary: `key valid; ${match.name} verified`, details };
  });
}

interface KeySource { source: string; key: string }

async function llmKeys(ctx: ProbeCtx, providers: string[], envNames: string[]): Promise<{ keys: KeySource[]; disabled: number }> {
  const keys: KeySource[] = [];
  for (const n of envNames) {
    const v = Deno.env.get(n);
    if (v) keys.push({ source: `env ${n}`, key: v });
  }
  const { data } = await ctx.admin.from("llm_providers").select("provider, api_key_encrypted, enabled").eq("org_id", ctx.orgId).in("provider", providers);
  let disabled = 0;
  for (const row of data ?? []) {
    if (!row.enabled) { disabled++; continue; }
    const k = await openSecret(row.api_key_encrypted).catch(() => null);
    if (k) keys.push({ source: `org ${row.provider} provider`, key: k });
  }
  return { keys, disabled };
}

const LLM = {
  anthropic: {
    name: "Anthropic", providers: ["anthropic"], env: ["ANTHROPIC_API_KEY"], required: true,
    ping: (k: string) => fetchT("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": k, "anthropic-version": "2023-06-01" } }),
  },
  openai: {
    name: "OpenAI", providers: ["openai"], env: ["OPENAI_API_KEY"], required: false,
    ping: (k: string) => fetchT("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${k}` } }),
  },
  gemini: {
    name: "Gemini", providers: ["google", "gemini"], env: ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY"], required: false,
    ping: (k: string) => fetchT("https://generativelanguage.googleapis.com/v1/models?pageSize=1", { headers: { "x-goog-api-key": k } }),
  },
} as const;

function probeLlm(ctx: ProbeCtx, which: keyof typeof LLM): Promise<CheckResult> {
  const spec = LLM[which];
  return check(`integrations.${which}`, "integrations", spec.name, async () => {
    const { keys, disabled } = await llmKeys(ctx, [...spec.providers], [...spec.env]);
    if (!keys.length) {
      if (spec.required) return { status: "fail", summary: "no API key configured", error: "no key" };
      return { status: "skip", summary: disabled ? "configured but disabled" : "not configured" };
    }
    const checks = await Promise.all(keys.map(async (k) => {
      try {
        const res = await spec.ping(k.key);
        await res.body?.cancel();
        return { source: k.source, httpStatus: res.status, ok: res.ok };
      } catch (e) {
        return { source: k.source, httpStatus: null, ok: false, error: errText(e) };
      }
    }));
    const bad = checks.filter((c) => !c.ok);
    const details = { keys: checks.map((c) => ({ source: c.source, httpStatus: c.httpStatus, valid: c.ok })) };
    if (bad.length) {
      return { status: "fail", summary: `${bad.length} of ${checks.length} key(s) rejected`, error: bad.map((b) => `${b.source}: ${b.httpStatus ?? "no response"}`).join("; "), details };
    }
    return { status: "pass", summary: `${checks.length} key(s) valid`, details };
  });
}

function probeElevenLabs(ctx: ProbeCtx): Promise<CheckResult> {
  return check("integrations.elevenlabs", "integrations", "ElevenLabs", async () => {
    const keys: KeySource[] = [];
    const env = Deno.env.get("ELEVENLABS_API_KEY");
    if (env) keys.push({ source: "env ELEVENLABS_API_KEY", key: env });
    const { data: conn } = await ctx.admin.from("elevenlabs_connection").select("api_key_encrypted, enabled").eq("org_id", ctx.orgId).maybeSingle();
    if (conn?.enabled && conn.api_key_encrypted) {
      const k = await openSecret(conn.api_key_encrypted).catch(() => null);
      if (k) keys.push({ source: "org connection", key: k });
    }
    if (!keys.length) return { status: "skip", summary: "not configured" };
    const results = await Promise.all(keys.map(async (k) => {
      const user = await fetchT("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": k.key } });
      await user.body?.cancel();
      if (user.ok) return { source: k.source, httpStatus: user.status, ok: true, note: "" };
      // Restricted keys may lack user_read; a models read still proves the key works.
      const models = await fetchT("https://api.elevenlabs.io/v1/models", { headers: { "xi-api-key": k.key } });
      await models.body?.cancel();
      return { source: k.source, httpStatus: models.status, ok: models.ok, note: models.ok ? "key lacks user_read" : "" };
    }));
    const bad = results.filter((r) => !r.ok);
    const details = { keys: results.map((r) => ({ source: r.source, httpStatus: r.httpStatus, valid: r.ok, note: r.note || undefined })) };
    if (bad.length) return { status: "fail", summary: `${bad.length} of ${results.length} key(s) rejected`, error: bad.map((b) => `${b.source}: ${b.httpStatus}`).join("; "), details };
    return { status: "pass", summary: `${results.length} key(s) valid`, details };
  });
}

// ── Agents ────────────────────────────────────────────────────────────────────────────────────

interface AgentUser extends AgentIdentity {
  userId: string | null;
}

async function resolveAgents(ctx: ProbeCtx): Promise<AgentUser[]> {
  const emails = ctx.agents.map((a) => a.email.toLowerCase());
  const { data } = await ctx.admin.from("users").select("id, email, organization_id").in("email", emails);
  const byEmail = new Map((data ?? []).filter((u) => u.organization_id === ctx.orgId).map((u) => [String(u.email).toLowerCase(), u.id as string]));
  return ctx.agents.map((a) => ({ ...a, userId: byEmail.get(a.email.toLowerCase()) ?? null }));
}

export async function probeAgents(ctx: ProbeCtx): Promise<CheckResult[]> {
  const agents = await resolveAgents(ctx);
  const ids = agents.map((a) => a.userId).filter((x): x is string => !!x);
  const sessions = ids.length ? await ctx.admin.rpc("system_health_agent_sessions", { p_user_ids: ids }) : { data: [], error: null };

  const perAgent = await Promise.all(agents.map(async (a) => {
    if (!a.userId) {
      return [{
        id: `agents.${a.slug}.heartbeat`, group: "agents" as const, name: `${a.label} heartbeat`, durationMs: 0, status: "fail" as const,
        summary: `no OS user ${a.email} in this org`, error: `agent user ${a.email} not found`,
      }];
    }
    const [hb, sched, runs, sess, ping] = await Promise.all([
      agentHeartbeat(ctx, a),
      agentSchedules(ctx, a),
      agentRuns(ctx, a),
      agentSession(a, sessions),
      evaluatePing(ctx, a),
    ]);
    return [hb, sched, runs, sess, ping];
  }));

  const [approvals, queues] = await Promise.all([probeApprovals(ctx), probeQueues(ctx, "agents")]);
  return [...perAgent.flat(), approvals, ...queues];
}

function agentHeartbeat(ctx: ProbeCtx, a: AgentUser): Promise<CheckResult> {
  return check(`agents.${a.slug}.heartbeat`, "agents", `${a.label} heartbeat`, async () => {
    const { data, error } = await ctx.admin.from("agent_heartbeats")
      .select("last_poll_at, poll_count, last_due, last_resolved").eq("agent_user_id", a.userId!).maybeSingle();
    if (error) return { status: "fail", summary: "heartbeat query failed", error: error.message };
    if (!data) return { status: "fail", summary: "no heartbeat ever recorded", error: "agent has never polled the OS task queue" };
    const nowMs = ctx.now();
    const age = ageMinutes(data.last_poll_at, nowMs);
    const status = heartbeatStatus(data.last_poll_at, nowMs);
    // Poll rate from the previous run's sample: delta poll_count / delta minutes.
    const prev = ctx.previous.find((r) => r.id === `agents.${a.slug}.heartbeat`)?.details as
      | { pollCount?: number; lastPollAt?: string }
      | undefined;
    let pollsPerMin: number | null = null;
    if (prev?.pollCount !== undefined && prev.lastPollAt && data.last_poll_at) {
      const dMin = (Date.parse(data.last_poll_at) - Date.parse(prev.lastPollAt)) / 60_000;
      const dCount = Number(data.poll_count ?? 0) - prev.pollCount;
      if (dMin > 0.5 && dCount >= 0) pollsPerMin = Math.round((dCount / dMin) * 100) / 100;
    }
    return {
      status,
      summary: `last poll ${age} min ago${pollsPerMin !== null ? `, ${pollsPerMin} polls/min since last run` : ""}`,
      error: status === "pass" ? undefined : `last poll ${age} min ago (warn 5, fail 20)`,
      details: { lastPollAt: data.last_poll_at, ageMin: age, pollCount: Number(data.poll_count ?? 0), pollsPerMin, lastDue: data.last_due },
    };
  });
}

function agentSchedules(ctx: ProbeCtx, a: AgentUser): Promise<CheckResult> {
  return check(`agents.${a.slug}.schedules`, "agents", `${a.label} schedules`, async () => {
    const { data, error } = await ctx.admin.from("agent_task_schedules")
      .select("task_key, next_run_at, mode").eq("agent_user_id", a.userId!).neq("mode", "off");
    if (error) return { status: "fail", summary: "schedule query failed", error: error.message };
    const rows = (data ?? []).filter((s) => !String(s.task_key).endsWith(".healthcheck_ping"));
    const cutoff = ctx.now() - 60 * 60_000;
    const overdue = rows.filter((s) => Date.parse(s.next_run_at) < cutoff);
    if (!rows.length) return { status: "warn", summary: "no active schedules (nothing for the agent to claim)", details: { active: 0 } };
    if (overdue.length) {
      return {
        status: "fail",
        summary: `${overdue.length} of ${rows.length} schedule(s) overdue > 60 min`,
        error: `overdue: ${overdue.slice(0, 5).map((s) => s.task_key).join(", ")}`,
        details: { active: rows.length, overdue: overdue.map((s) => ({ taskKey: s.task_key, nextRunAt: s.next_run_at })) },
      };
    }
    return { status: "pass", summary: `${rows.length} active, none overdue`, details: { active: rows.length } };
  });
}

function agentRuns(ctx: ProbeCtx, a: AgentUser): Promise<CheckResult> {
  return check(`agents.${a.slug}.runs`, "agents", `${a.label} runs`, async () => {
    const since = new Date(ctx.now() - 24 * 3600_000).toISOString();
    const [recent, last] = await Promise.all([
      ctx.admin.from("agent_task_runs").select("status, lease_expires_at, error").eq("agent_user_id", a.userId!).gte("created_at", since).limit(2000),
      ctx.admin.from("agent_task_runs").select("created_at, status").eq("agent_user_id", a.userId!).order("created_at", { ascending: false }).limit(1),
    ]);
    if (recent.error) return { status: "fail", summary: "run query failed", error: recent.error.message };
    const rows = recent.data ?? [];
    const failed = rows.filter((r) => r.status === "failed" || r.status === "expired_lease");
    const nowMs = ctx.now();
    const stuck = rows.filter((r) => (r.status === "claimed" || r.status === "running") && Date.parse(r.lease_expires_at) < nowMs);
    let status = failureRateStatus(failed.length, rows.length);
    if (status === "pass" && stuck.length) status = "warn";
    const lastRun = last.data?.[0];
    const lastAge = ageMinutes(lastRun?.created_at, nowMs);
    const topError = failed.find((f) => f.error)?.error;
    return {
      status,
      summary: `${rows.length} run(s) in 24h, ${failed.length} failed${stuck.length ? `, ${stuck.length} past lease` : ""}; last run ${lastAge ?? "never"}${lastAge !== null ? " min ago" : ""}`,
      error: status === "pass" ? undefined : scrubSecrets(topError ? `latest failure: ${topError}` : `${stuck.length} run(s) past lease`),
      details: { runs24h: rows.length, failed24h: failed.length, pastLease: stuck.length, lastRunAt: lastRun?.created_at ?? null },
    };
  });
}

function agentSession(
  a: AgentUser,
  sessions: { data: unknown; error: { code?: string; message: string } | null },
): Promise<CheckResult> {
  return check(`agents.${a.slug}.session`, "agents", `${a.label} OS session`, async () => {
    if (sessions.error) {
      return {
        status: "fail",
        summary: isMissingRpc(sessions.error) ? `RPC missing — ${MIGRATION_HINT}` : "session query failed",
        error: sessions.error.message,
      };
    }
    const row = ((sessions.data ?? []) as Array<{
      user_id: string; banned_until: string | null; active_sessions: number; last_refresh_at: string | null; last_sign_in_at: string | null;
    }>).find((r) => r.user_id === a.userId);
    if (!row) return { status: "fail", summary: "no auth user", error: "agent has no auth.users row" };
    const now = Date.now();
    if (row.banned_until && Date.parse(row.banned_until) > now) return { status: "fail", summary: "agent user is banned", error: `banned until ${row.banned_until}` };
    if (!row.active_sessions) return { status: "fail", summary: "no live session — re-capture the agent's OS login", error: "0 active sessions" };
    const age = ageMinutes(row.last_refresh_at, now);
    const status: CheckStatus = age === null ? "warn" : age > 24 * 60 ? "fail" : age > 120 ? "warn" : "pass";
    return {
      status,
      summary: `${row.active_sessions} live session(s); last refresh ${age ?? "?"} min ago`,
      error: status === "pass" ? undefined : `session last refreshed ${age} min ago`,
      details: { activeSessions: row.active_sessions, lastRefreshAt: row.last_refresh_at, lastSignInAt: row.last_sign_in_at },
    };
  });
}

function pingTaskKey(slug: string): string {
  return `${slug}.healthcheck_ping`;
}

/**
 * Evaluate (and when finished, clean up) an outstanding agent ping. Deleting the ping schedule
 * cascades its run. A ping that never gets claimed is deleted at the timeout so it cannot fire
 * again next month.
 */
function evaluatePing(ctx: ProbeCtx, a: AgentUser): Promise<CheckResult> {
  return check(`agents.${a.slug}.ping`, "agents", `${a.label} active ping`, async () => {
    const { data: scheds, error } = await ctx.admin.from("agent_task_schedules")
      .select("id, created_at").eq("agent_user_id", a.userId!).eq("task_key", pingTaskKey(a.slug))
      .like("title", `${HEALTHCHECK_TAG_PREFIX}%`).order("created_at", { ascending: false });
    if (error) return { status: "fail", summary: "ping lookup failed", error: error.message };
    if (!scheds?.length) return { status: "skip", summary: "no ping in flight — use “Ping agents” to send one" };
    const s = scheds[0];
    const { data: run } = await ctx.admin.from("agent_task_runs")
      .select("claimed_at, created_at, status, error").eq("schedule_id", s.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
    const o = pingOutcome({ createdAt: s.created_at, claimedAt: run ? (run.claimed_at ?? run.created_at) : null, nowMs: ctx.now(), timeoutMin: PING_TIMEOUT_MIN });
    if (o.status === "pending") {
      return { status: "warn", summary: o.reason, details: { pending: true, scheduleCreatedAt: s.created_at } };
    }
    const { error: delErr } = await ctx.admin.from("agent_task_schedules").delete().in("id", scheds.map((x) => x.id));
    return {
      status: o.status,
      summary: `${o.reason}${delErr ? "; cleanup failed" : "; ping removed"}`,
      error: o.status === "fail"
        ? `not claimed within ${PING_TIMEOUT_MIN} min: agent offline, OS-task gate off, or schedules not owned by ${a.email}`
        : delErr?.message,
      details: { latencySec: o.latencySec, runStatus: run?.status ?? null, cleanupError: delErr?.message ?? null },
    };
  });
}

/** Insert one tagged, shadow-mode ping schedule per agent, due now. The agent's next poll claims it. */
export async function startAgentPings(ctx: ProbeCtx, slugs?: string[]): Promise<CheckResult[]> {
  const agents = (await resolveAgents(ctx)).filter((a) => !slugs?.length || slugs.includes(a.slug));
  return await Promise.all(agents.map((a) =>
    check(`agents.${a.slug}.ping`, "agents", `${a.label} active ping`, async () => {
      if (!a.userId) return { status: "fail", summary: `no OS user ${a.email}`, error: "agent user not found" };
      const { error } = await ctx.admin.from("agent_task_schedules").insert({
        org_id: ctx.orgId,
        agent_user_id: a.userId,
        agent_slug: a.slug,
        task_key: pingTaskKey(a.slug), // no handler exists: the agent claims it and reports "no handler" — a no-op
        title: `${HEALTHCHECK_TAG_PREFIX} ping ${ctx.runId}`,
        description: "System Health active ping. Claimed on the next poll, then deleted by System Health.",
        cadence: "monthly",
        day_of_month: 1,
        next_run_at: new Date(ctx.now()).toISOString(),
        risk_tier: "autonomous",
        output_kind: "none",
        approval_required: false,
        mode: "shadow",
        catch_up_policy: "skip",
        max_runtime_minutes: 5,
        config: { healthcheck: true, noop: true },
        created_by_user_id: ctx.userId,
      });
      if (error) {
        if (error.code === "23505") return { status: "warn", summary: "a ping is already in flight — run the Agents group to see it", details: { pending: true } };
        return { status: "fail", summary: "could not enqueue ping", error: error.message };
      }
      return { status: "warn", summary: `ping sent; expect pickup within ${PING_TIMEOUT_MIN} min — re-run Agents to check`, details: { pending: true } };
    })
  ));
}

function probeApprovals(ctx: ProbeCtx): Promise<CheckResult> {
  return check("agents.approvals", "agents", "Pending approvals", async () => {
    const [cnt, oldest] = await Promise.all([
      ctx.admin.from("workflow_approval_queue").select("id", { count: "exact", head: true }).eq("org_id", ctx.orgId).eq("status", "pending_approval"),
      ctx.admin.from("workflow_approval_queue").select("created_at, title").eq("org_id", ctx.orgId).eq("status", "pending_approval")
        .order("created_at", { ascending: true }).limit(1),
    ]);
    if (cnt.error) return { status: "fail", summary: "query failed", error: cnt.error.message };
    const pending = cnt.count ?? 0;
    const age = ageMinutes(oldest.data?.[0]?.created_at, ctx.now());
    const status = backlogStatus(pending, age, { warnAgeMin: 24 * 60, failAgeMin: 72 * 60 });
    const hours = age === null ? null : Math.round(age / 60);
    return {
      status,
      summary: pending ? `${pending} pending, oldest ${hours} h` : "none pending",
      error: status === "pass" ? undefined : `oldest pending approval is ${hours} h old`,
      details: { pending, oldestAgeHours: hours },
    };
  });
}
