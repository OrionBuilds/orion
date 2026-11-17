/**
 * CAIO generation: load everything for one document from the db (service-role client), run hydrate +
 * narrative + readiness, and write the document, its field provenance and the input requests.
 *
 * `generate()` is the single entry point shared by the caio-generate (owner / cron) and caio-generator (queue)
 * edge functions. It never approves, publishes or sends anything. A NEW document is inserted as a draft; an
 * existing DRAFT is regenerated with merge (confirmed / edited text kept); anything else is refused.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  applyNarrative, hydrate, htmlToText, unresolvedNames,
  type ExistingField, type Fill, type PlaceholderDef, type RecordInput,
} from "./hydrate.ts";
import { buildContextPack, draftNarrative, type NarrativeAsk, type PackRecord } from "./narrative.ts";
import { computeNeeds, syncInputRequests, type NeedInput } from "./readiness.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** Templates produced once per period: weekly memo, monthly report, quarterly governance review. */
export const RECURRING = new Set([29, 30, 35]);
/** Registers whose records the monthly report is built from. */
const MONTHLY_REGISTERS = ["kpi_log", "budget", "incidents", "actions"];
const MAX_SOURCE_CHARS = 40_000;

const day = (d: Date) => d.toISOString().slice(0, 10);

/** `period:2026-W45` in a job reason, else the UTC date. */
export function periodFor(reason: string | null | undefined, now: Date): string {
  const m = (reason ?? "").match(/^period:(\S+)/);
  return m ? m[1].slice(0, 20) : day(now);
}

export interface GenerateParams {
  orgId: string; engagementId: string; templateNumber: number;
  systemKey?: string | null; documentId?: string | null; jobId?: string | null; reason?: string | null; actorId?: string | null;
}
export interface GenerateDeps {
  db: SupabaseClient;
  /** null: no model (no key, over cap, or a manual run that should stay deterministic). */
  ask: NarrativeAsk | null;
  now: () => Date;
  timeoutMs?: number;
}
export type GenerateResult =
  | {
    ok: true; document_id: string; filled: number; unresolved: { name: string; resolver: string }[];
    needs_input: { kind: string; key: string; label: string }[]; created: boolean; model_calls: number;
  }
  | { ok: false; error: string };

interface Loaded {
  template: Row; engagement: Row; defs: PlaceholderDef[]; facts: Row[]; records: Row[]; factDefs: Row[]; registers: Row[];
  idFields: Record<string, string[]>; existing: Row | null; existingFields: ExistingField[]; sources: Row[]; templateTitles: Record<number, string>;
}

async function list(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw new Error(`load failed: ${String((error as { message?: string }).message ?? error).slice(0, 200)}`);
  return (data ?? []) as Row[];
}

export async function loadForGeneration(db: SupabaseClient, p: GenerateParams, recurring: boolean): Promise<Loaded | { error: string }> {
  const { data: template } = await db.from("caio_templates").select("*").eq("org_id", p.orgId).eq("number", p.templateNumber).maybeSingle();
  if (!template) return { error: "template_not_found" };
  if (template.enabled === false) return { error: "template_disabled" };
  const { data: engagement } = await db.from("caio_engagements").select("*").eq("id", p.engagementId).eq("org_id", p.orgId).maybeSingle();
  if (!engagement) return { error: "engagement_not_found" };

  const [defs, facts, records, factDefs, registers, fields, templates, sources] = await Promise.all([
    list(db.from("caio_placeholder_defs").select("name, resolver, target").limit(3000)),
    list(db.from("caio_facts").select("id, fact_key, value, status, source_id, updated_at").eq("engagement_id", p.engagementId).limit(1000)),
    list(db.from("caio_records").select("id, register_key, record_key, system_key, data, updated_at").eq("engagement_id", p.engagementId).order("record_key", { ascending: true }).limit(5000)),
    list(db.from("caio_fact_defs").select("fact_key, label, templates").limit(500)),
    list(db.from("caio_registers").select("register_key, title").limit(100)),
    list(db.from("caio_register_fields").select("register_key, field_key, is_id").eq("is_id", true).limit(500)),
    list(db.from("caio_templates").select("number, title").eq("org_id", p.orgId).limit(200)),
    list(db.from("caio_sources").select("id, title, text_content, created_at, updated_at").eq("engagement_id", p.engagementId).eq("process_status", "ready").order("created_at", { ascending: false }).limit(40)),
  ]);

  let existing: Row | null = null;
  if (p.documentId) {
    const { data } = await db.from("caio_documents").select("*").eq("id", p.documentId).eq("engagement_id", p.engagementId).maybeSingle();
    if (!data) return { error: "document_not_found" };
    existing = data;
  } else if (!recurring) {
    let q = db.from("caio_documents").select("*").eq("engagement_id", p.engagementId).eq("template_number", p.templateNumber).neq("status", "superseded");
    q = p.systemKey ? q.eq("system_key", p.systemKey) : q.is("system_key", null);
    const { data } = await q.order("version", { ascending: false }).limit(1);
    existing = (data as Row[] | null)?.[0] ?? null;
  }
  const existingFields = existing
    ? (await list(db.from("caio_document_fields").select("mark_id, placeholder, status").eq("document_id", existing.id).limit(5000))) as unknown as ExistingField[]
    : [];
  const idFields: Record<string, string[]> = {};
  for (const f of fields) (idFields[f.register_key] ??= []).push(f.field_key);
  return {
    template, engagement, defs: defs as unknown as PlaceholderDef[], facts, records, factDefs, registers, idFields, existing, existingFields,
    sources: sources.map((s) => ({ ...s, text_content: String(s.text_content ?? "").slice(0, MAX_SOURCE_CHARS) })),
    templateTitles: Object.fromEntries(templates.map((t) => [t.number, t.title])),
  };
}

/** Hash of the inputs a document was generated from, so the UI can say "stale" later. */
export async function fingerprint(facts: Row[], records: Row[], sources: Row[]): Promise<Row> {
  const f = facts.map((x) => `${x.id}@${x.updated_at}`).sort();
  const maxRec = records.reduce((m, r) => (String(r.updated_at ?? "") > m ? String(r.updated_at) : m), "");
  const src = sources.map((s) => s.id).sort();
  const bytes = new TextEncoder().encode(JSON.stringify([f, maxRec, records.length, src]));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hash, facts: f.length, records: records.length, records_max: maxRec, source_ids: src };
}

/** Last 7 days of changes, as plain lines for the weekly memo. */
export function recentChanges(l: Pick<Loaded, "facts" | "records" | "sources">, now: Date): string {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const out: string[] = [];
  for (const r of l.records) if (String(r.updated_at ?? "") >= since) out.push(`record ${r.register_key} ${r.record_key ?? ""} changed on ${String(r.updated_at).slice(0, 10)}`);
  for (const f of l.facts) if (String(f.updated_at ?? "") >= since) out.push(`fact ${f.fact_key} (${f.status}) changed on ${String(f.updated_at).slice(0, 10)}`);
  for (const s of l.sources) if (String(s.created_at ?? "") >= since) out.push(`source added: ${s.title} on ${String(s.created_at).slice(0, 10)}`);
  return out.slice(0, 60).join("\n");
}

export async function generate(deps: GenerateDeps, p: GenerateParams): Promise<GenerateResult> {
  const { db } = deps;
  const now = deps.now();
  const recurring = RECURRING.has(p.templateNumber) && !p.documentId;
  const l = await loadForGeneration(db, p, RECURRING.has(p.templateNumber));
  if ("error" in l) return { ok: false, error: l.error };

  if (l.existing) {
    if (l.existing.status === "approved") return { ok: false, error: "approved_use_revise" };
    if (l.existing.status !== "draft") return { ok: false, error: `document_${l.existing.status}` };
  }
  const systemKey = p.systemKey ?? l.existing?.system_key ?? null;
  const feeds: string[] = l.template.feeds ?? [];
  const records: RecordInput[] = l.records.map((r) => ({ id: r.id, register_key: r.register_key, record_key: r.record_key, system_key: r.system_key, data: r.data ?? {} }));
  const engagementInfo = { ...l.engagement };

  const base = hydrate({
    html: l.existing ? String(l.existing.body_html ?? "") : String(l.template.body_html ?? ""),
    defs: l.defs, engagement: engagementInfo, facts: l.facts as never, records, feeds, systemKey, today: day(now),
    docVersion: l.existing?.version ?? 1, docStatus: "Draft", idFields: l.idFields,
    existingFields: l.existing ? l.existingFields : undefined,
  });
  let html = base.html;
  const fills: Fill[] = [...base.fills];
  let modelCalls = 0;

  if (base.llmTargets.length && deps.ask) {
    const recs: PackRecord[] = records.map((r) => ({ register_key: r.register_key, record_key: r.record_key, data: r.data }));
    const priority = new Set([...feeds, ...(p.templateNumber === 30 ? MONTHLY_REGISTERS : [])]);
    recs.sort((a, b) => Number(priority.has(b.register_key)) - Number(priority.has(a.register_key)));
    const factLabel = new Map(l.factDefs.map((f) => [f.fact_key, f.label]));
    const pack = buildContextPack({
      facts: l.facts.filter((f) => f.status === "confirmed" || f.status === "proposed").map((f) => ({ fact_key: f.fact_key, label: factLabel.get(f.fact_key), value: f.value, status: f.status })),
      records: recs,
      sources: l.sources.map((s) => ({ id: s.id, title: s.title, text_content: s.text_content })),
      recentChanges: p.templateNumber === 29 ? recentChanges(l, now) : undefined,
      docText: htmlToText(html),
      keywords: [l.template.title, ...base.llmTargets.flatMap((t) => [t.name, t.hint])],
    });
    const humanNames = new Set(l.defs.filter((d) => d.resolver === "human").map((d) => d.name));
    const r = await draftNarrative({
      targets: base.llmTargets, pack, ask: deps.ask, templateTitle: l.template.title, clientName: String(l.engagement.client_legal_name ?? ""),
      timeoutMs: deps.timeoutMs ?? 30_000, humanNames,
    });
    modelCalls = r.calls;
    const applied = applyNarrative(html, base.llmTargets, r.values);
    html = applied.html;
    fills.push(...applied.fills);
  }

  const stillOpen = new Set(unresolvedNames(html));
  const unresolved = base.unresolved.filter((u) => stillOpen.has(u.name));
  const finger = await fingerprint(l.facts, l.records, l.sources);

  // ── write the document ────────────────────────────────────────────────────────────────
  let documentId: string;
  let created = false;
  if (l.existing) {
    documentId = l.existing.id;
    const { error } = await db.from("caio_documents").update({
      body_html: html, generated_at: now.toISOString(), generated_from: finger, generation_job_id: p.jobId ?? null,
    }).eq("id", documentId);
    if (error) return { ok: false, error: `document_update_failed: ${error.message.slice(0, 160)}` };
  } else {
    const suffix = recurring ? ` - ${periodFor(p.reason, now)}` : systemKey ? ` - ${systemKey}` : "";
    const { data, error } = await db.from("caio_documents").insert({
      org_id: p.orgId, engagement_id: p.engagementId, template_id: l.template.id, template_number: p.templateNumber,
      title: `${l.template.title}${suffix}`, system_key: systemKey, version: 1, status: "draft", body_html: html,
      generated_at: now.toISOString(), generated_from: finger, generation_job_id: p.jobId ?? null, created_by: p.actorId ?? null,
    }).select("id").single();
    if (error || !data) return { ok: false, error: `document_insert_failed: ${String(error?.message ?? "").slice(0, 160)}` };
    documentId = (data as { id: string }).id;
    created = true;
  }

  // ── provenance rows ───────────────────────────────────────────────────────────────────
  if (fills.length) {
    const { error } = await db.from("caio_document_fields").upsert(fills.map((f) => ({
      document_id: documentId, mark_id: f.markId, placeholder: f.placeholder, value: f.value, resolver: f.resolver,
      source_ref: f.sourceRef, source_ids: f.sourceIds, confidence: f.confidence, status: "auto", updated_at: now.toISOString(),
    })), { onConflict: "document_id,mark_id" });
    if (error) return { ok: false, error: `fields_failed: ${error.message.slice(0, 160)}` };
  }
  const present = new Set([...html.matchAll(/<mark\b[^>]*\bdata-auto="([^"]*)"/g)].map((m) => m[1]));
  const stale = l.existingFields.filter((f) => f.status === "auto" && !present.has(f.mark_id)).map((f) => f.mark_id);
  if (stale.length) await db.from("caio_document_fields").delete().eq("document_id", documentId).eq("status", "auto").in("mark_id", stale);

  // ── readiness ─────────────────────────────────────────────────────────────────────────
  const withRecords = new Set(records.map((r) => r.register_key));
  const needs: NeedInput[] = computeNeeds({
    unresolved, defs: l.defs, feeds, templateNumber: p.templateNumber, facts: l.facts as never, registersWithRecords: withRecords,
    factDefs: l.factDefs.map((f) => ({ fact_key: f.fact_key, label: f.label, templates: f.templates ?? [] })),
    registerTitles: Object.fromEntries(l.registers.map((r) => [r.register_key, r.title])),
  });
  try {
    await syncInputRequests(db, {
      orgId: p.orgId, engagementId: p.engagementId, templateNumber: p.templateNumber, templateTitle: l.template.title, needs,
      templateTitles: l.templateTitles, facts: l.facts as never, registersWithRecords: withRecords,
    });
  } catch (e) { console.warn("[caio-generate] input requests:", String((e as Error).message).slice(0, 200)); }

  return {
    ok: true, document_id: documentId, filled: fills.length, unresolved,
    needs_input: needs.map((n) => ({ kind: n.kind, key: n.key, label: n.label })), created, model_calls: modelCalls,
  };
}

// ── job helpers shared by the runner ────────────────────────────────────────────────────────

/** Model calls already spent this UTC month on an engagement (from finished jobs' results). */
export async function modelCallsThisMonth(db: SupabaseClient, engagementId: string, now: Date): Promise<number> {
  const start = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const rows = await list(db.from("caio_generation_jobs").select("result").eq("engagement_id", engagementId).eq("status", "done").gte("finished_at", start).limit(2000));
  return rows.reduce((n, r) => n + (Number(r.result?.model_calls) || 0), 0);
}

export interface NotifyFn { (req: { kind: string; priority: "normal"; text: string; dedupeKey: string }): Promise<unknown> }

/** Tell the owner (and only the owner) that drafts are waiting: at most once per engagement per UTC day. */
export async function notifyDraftsReady(db: SupabaseClient, notify: NotifyFn, o: { engagementId: string; clientName: string; now: Date }): Promise<number> {
  const dayKey = day(o.now);
  const { data } = await db.from("caio_documents").select("id").eq("engagement_id", o.engagementId).eq("status", "draft").gte("generated_at", `${dayKey}T00:00:00.000Z`).limit(500);
  const n = (data as unknown[] | null)?.length ?? 0;
  if (!n) return 0;
  await notify({
    kind: "caio.drafts_ready", priority: "normal", dedupeKey: `caio-drafts:${o.engagementId}:${dayKey}`,
    text: `${n} CAIO draft${n === 1 ? " is" : "s are"} ready to review for ${o.clientName || "your client"}`,
  });
  return n;
}

// ── queue job runner ────────────────────────────────────────────────────────────────────────
export interface Job {
  id: string; org_id: string; engagement_id: string; template_number: number; system_key: string | null;
  trigger_kind: string; reason: string | null; attempts: number;
}
export interface JobOutcome { status: "done" | "skipped" | "blocked" | "failed" | "queued"; reason?: string; modelCalls: number; produced: boolean; client: string }
export const MAX_ATTEMPTS = 3;

/** Run one claimed job (attempts was already incremented by caio_claim_job) and record its outcome on the row. */
export async function runJob(deps: GenerateDeps, job: Job): Promise<JobOutcome> {
  const { db } = deps;
  const now = deps.now();
  const finish = async (patch: Row) => { await db.from("caio_generation_jobs").update(patch).eq("id", job.id); };
  const { data: eng } = await db.from("caio_engagements").select("client_legal_name, automation_enabled, ai_monthly_cap").eq("id", job.engagement_id).maybeSingle();
  const client = String(eng?.client_legal_name ?? "");
  const out = (o: Omit<JobOutcome, "client">): JobOutcome => ({ ...o, client });

  if (!eng) {
    await finish({ status: "skipped", finished_at: now.toISOString(), result: { reason: "engagement_not_found" } });
    return out({ status: "skipped", reason: "engagement_not_found", modelCalls: 0, produced: false });
  }
  if (job.trigger_kind !== "manual" && !eng.automation_enabled) {
    await finish({ status: "skipped", finished_at: now.toISOString(), result: { reason: "automation_off" } });
    return out({ status: "skipped", reason: "automation_off", modelCalls: 0, produced: false });
  }
  const used = await modelCallsThisMonth(db, job.engagement_id, now);
  if (used >= (Number(eng.ai_monthly_cap) || 0)) {
    await finish({ status: "blocked", finished_at: now.toISOString(), last_error: "over_monthly_cap", result: { reason: "over_monthly_cap", used } });
    return out({ status: "blocked", reason: "over_monthly_cap", modelCalls: 0, produced: false });
  }

  let err = "";
  try {
    const r = await generate(deps, {
      orgId: job.org_id, engagementId: job.engagement_id, templateNumber: job.template_number, systemKey: job.system_key, jobId: job.id, reason: job.reason,
    });
    if (r.ok) {
      await finish({
        status: "done", finished_at: now.toISOString(), document_id: r.document_id, last_error: null,
        result: { document_id: r.document_id, filled: r.filled, unresolved: r.unresolved.map((u) => u.name).slice(0, 80), needs_input: r.needs_input.length, created: r.created, model_calls: r.model_calls },
      });
      return out({ status: "done", modelCalls: r.model_calls, produced: true });
    }
    if (r.error === "approved_use_revise" || r.error === "template_disabled" || r.error === "template_not_found") {
      await finish({ status: "skipped", finished_at: now.toISOString(), result: { reason: r.error } });
      return out({ status: "skipped", reason: r.error, modelCalls: 0, produced: false });
    }
    err = r.error;
  } catch (e) { err = String((e as Error).message ?? e); }

  err = err.slice(0, 200);
  if (job.attempts >= MAX_ATTEMPTS) {
    await finish({ status: "failed", finished_at: now.toISOString(), last_error: err, result: { reason: "failed" } });
    return out({ status: "failed", reason: err, modelCalls: 0, produced: false });
  }
  await finish({ status: "queued", claimed_at: null, last_error: err, run_after: new Date(now.getTime() + job.attempts * 5 * 60_000).toISOString() });
  return out({ status: "queued", reason: err, modelCalls: 0, produced: false });
}
