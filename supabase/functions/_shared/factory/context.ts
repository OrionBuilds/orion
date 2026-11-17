/**
 * What a factory step knows about its subject. Read-only, org-scoped, capped. Every query is
 * best-effort: a missing table or a failed read becomes "unknown" in the context instead of failing the
 * step, and the agent is told to say "unknown" rather than guess.
 *
 * Text written by third parties (messages, transcripts, notes, web pages) is fenced as UNTRUSTED data;
 * the step prompt tells the model it is information, never instructions.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { caioStatus, summarize } from "../caio/status.ts";
import { BRANDS } from "../brands.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

export interface RunRow { id: string; org_id: string; playbook_id: string; subject_type: "opportunity" | "project" | "org"; subject_id: string | null; brand: string | null }
export interface Section { title: string; body: string; untrusted?: boolean }

/** Public sites of the configured brands (ORION_BRANDS siteUrl), for the monthly visibility review. */
export const BRAND_SITES: Record<string, string> = Object.fromEntries(
  BRANDS.filter((b) => b.siteUrl).map((b) => [b.key, b.siteUrl as string]),
);
export const BRAND_NAMES: Record<string, string> = Object.fromEntries(BRANDS.map((b) => [b.key, b.label]));

const cap = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
const j = (v: unknown, n = 4000) => cap(JSON.stringify(v, null, 1), n);

async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Json[]> {
  try { const { data, error } = await q; return error ? [] : ((data ?? []) as Json[]); } catch { return []; }
}
async function one(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Json | null> {
  try { const { data, error } = await q; return error ? null : (data as Json | null); } catch { return null; }
}

async function contactSections(db: SupabaseClient, orgId: string, contactId: string | null): Promise<Section[]> {
  if (!contactId) return [{ title: "Contact", body: "unknown (no contact linked)" }];
  const c = await one(db.from("contacts").select("id, first_name, last_name, email, company, job_title, city, state, source, status, brand, lead_score").eq("organization_id", orgId).eq("id", contactId).maybeSingle());
  const out: Section[] = [{ title: "Contact", body: c ? j(c, 1200) : "unknown" }];
  const notes = await rows(db.from("contact_notes").select("title, content, created_at").eq("contact_id", contactId).order("created_at", { ascending: false }).limit(8));
  if (notes.length) out.push({ title: "Contact notes", untrusted: true, body: notes.map((n) => `- ${String(n.created_at).slice(0, 10)} ${cap(n.title, 80)}: ${cap(n.content, 500)}`).join("\n") });
  const msgs = await rows(db.from("messages").select("channel, direction, subject, body, created_at").eq("organization_id", orgId).eq("contact_id", contactId).is("hidden_at", null).order("created_at", { ascending: false }).limit(10));
  if (msgs.length) out.push({ title: "Recent messages (newest first)", untrusted: true, body: msgs.map((m) => `- ${String(m.created_at).slice(0, 16)} ${m.channel} ${m.direction}${m.subject ? ` "${cap(m.subject, 80)}"` : ""}: ${cap(m.body, 400)}`).join("\n") });
  const mt = await rows(db.from("meeting_transcriptions").select("meeting_title, meeting_date, summary, key_points, action_items, transcript_text").eq("org_id", orgId).eq("contact_id", contactId).order("meeting_date", { ascending: false }).limit(3));
  if (mt.length) {
    out.push({
      title: "Meetings (newest first)", untrusted: true,
      body: mt.map((m, i) => `### ${cap(m.meeting_title, 100)} (${String(m.meeting_date ?? "").slice(0, 10)})\nSummary: ${cap(m.summary, 1500)}\nKey points: ${j(m.key_points, 800)}\nAction items: ${j(m.action_items, 800)}${i === 0 ? `\nTranscript (start): ${cap(m.transcript_text, 6000)}` : ""}`).join("\n\n"),
    });
  }
  return out;
}

async function priorSteps(db: SupabaseClient, runId: string, exceptId: string): Promise<Section | null> {
  const done = await rows(db.from("playbook_step_runs").select("id, status, output, stage_name, agent, playbook_steps(key, title)").eq("run_id", runId).in("status", ["done", "needs_approval"]).order("updated_at").limit(20));
  const items = done.filter((d) => d.id !== exceptId && d.output);
  if (!items.length) return null;
  return { title: "Earlier steps in this play (agent work, verify before relying on it)", body: items.map((d) => `### ${d.playbook_steps?.title ?? "step"} (${d.agent}, ${d.status})\n${cap(d.output, 2500)}`).join("\n\n") };
}

async function opportunitySections(db: SupabaseClient, run: RunRow): Promise<Section[]> {
  const o = await one(db.from("opportunities").select("id, name, description, value_amount, currency, status, source, close_date, brand, contact_id, pipelines(name), pipeline_stages(name)").eq("org_id", run.org_id).eq("id", run.subject_id!).maybeSingle());
  if (!o) return [{ title: "Deal", body: "unknown (deal not found)" }];
  const out: Section[] = [{ title: "Deal", body: j({ ...o, pipeline: o.pipelines?.name, stage: o.pipeline_stages?.name, pipelines: undefined, pipeline_stages: undefined }, 1500) }];
  out.push(...await contactSections(db, run.org_id, o.contact_id));
  const props = await rows(db.from("proposals").select("title, status, total_value, currency, sent_at, summary").eq("org_id", run.org_id).eq("opportunity_id", o.id).order("created_at", { ascending: false }).limit(3));
  if (props.length) out.push({ title: "Proposals", body: j(props, 2000) });
  const inv = await rows(db.from("invoices").select("doc_number, status, total, currency, due_date, sent_at, paid_at").eq("org_id", run.org_id).eq("opportunity_id", o.id).limit(5));
  if (inv.length) out.push({ title: "Invoices", body: j(inv, 1500) });
  const k = await rows(db.from("contracts").select("title, status, signature_status, total_value, effective_date, content").eq("org_id", run.org_id).eq("opportunity_id", o.id).order("created_at", { ascending: false }).limit(1));
  if (k.length) out.push({ title: "Contract (latest)", untrusted: true, body: j(k[0], 5000) });
  return out;
}

async function projectSections(db: SupabaseClient, run: RunRow): Promise<Section[]> {
  const p = await one(db.from("projects").select("id, name, description, status, priority, start_date, target_end_date, budget_amount, currency, progress_percent, risk_level, brand, contact_id, repo_urls, staging_url, netlify_site_url, project_stages(name)").eq("org_id", run.org_id).eq("id", run.subject_id!).maybeSingle());
  if (!p) return [{ title: "Project", body: "unknown (project not found)" }];
  const out: Section[] = [{ title: "Project", body: j({ ...p, stage: p.project_stages?.name, project_stages: undefined }, 1500) }];
  const tasks = await rows(db.from("project_tasks").select("title, status, priority, due_date, completed_at").eq("org_id", run.org_id).eq("project_id", p.id).order("sort_order").limit(40));
  if (tasks.length) out.push({ title: "Project tasks", body: tasks.map((t) => `- [${t.status}] ${cap(t.title, 120)}${t.due_date ? ` (due ${t.due_date})` : ""}`).join("\n") });
  // A Fractional CAIO client: the engagement's gates, overdue items and document state, so steps (briefs, reports)
  // reason from the same numbers the CAIO module shows.
  try {
    const caio = await caioStatus(db, run.org_id, { projectId: p.id });
    if (caio[0]) out.push({ title: "CAIO engagement status", body: `${summarize(caio[0])}\n${j({ next_gate: caio[0].next_gate, counts: caio[0].counts, documents: caio[0].documents, attention: caio[0].attention }, 3000)}` });
  } catch { /* the CAIO module is optional: no section when its tables are missing */ }
  out.push(...await contactSections(db, run.org_id, p.contact_id));
  return out;
}

/** Org playbooks: what each rhythm needs (pipeline, money, factory health, delivered work, websites). */
async function orgSections(db: SupabaseClient, run: RunRow, playbookSlug: string, fetcher: typeof fetch): Promise<Section[]> {
  const out: Section[] = [];
  const org = run.org_id;
  if (playbookSlug.startsWith("ops-") || playbookSlug.startsWith("finance-")) {
    const opps = await rows(db.from("opportunities").select("name, value_amount, status, brand, stage_changed_at, close_date, pipelines(name), pipeline_stages(name, aging_threshold_days)").eq("org_id", org).eq("status", "open").limit(80));
    out.push({ title: "Open deals", body: opps.length ? opps.map((o) => `- ${cap(o.name, 80)} | ${o.brand} | ${o.pipelines?.name}/${o.pipeline_stages?.name} | $${o.value_amount ?? "?"} | in stage since ${String(o.stage_changed_at ?? "?").slice(0, 10)} (aging threshold ${o.pipeline_stages?.aging_threshold_days ?? "none"}d)`).join("\n") : "none" });
  }
  if (playbookSlug.startsWith("finance-") || playbookSlug.startsWith("ops-")) {
    const inv = await rows(db.from("invoices").select("doc_number, status, total, currency, due_date, sent_at, paid_at, contact_id, reminder_count").eq("org_id", org).neq("status", "void").order("due_date", { ascending: true }).limit(60));
    out.push({ title: "Invoices (open first by due date)", body: inv.length ? j(inv, 5000) : "none recorded" });
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const pay = await rows(db.from("payments").select("amount, currency, received_at, payment_method").eq("org_id", org).gte("received_at", since).limit(60));
    out.push({ title: "Payments, last 45 days", body: pay.length ? j(pay, 2500) : "none recorded" });
    const rec = await rows(db.from("recurring_profiles").select("name, frequency, status, next_invoice_date").eq("org_id", org).limit(30));
    if (rec.length) out.push({ title: "Recurring invoices", body: j(rec, 1500) });
  }
  if (playbookSlug.startsWith("ops-")) {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const steps = await rows(db.from("playbook_step_runs").select("status, agent, error").eq("org_id", org).gte("updated_at", since).limit(500));
    const counts: Record<string, number> = {};
    for (const s of steps) counts[`${s.agent}:${s.status}`] = (counts[`${s.agent}:${s.status}`] ?? 0) + 1;
    out.push({ title: "Factory steps last 7 days (agent:status = count)", body: j(counts, 1500) });
    const errs = steps.filter((s) => s.error).slice(0, 10).map((s) => `- ${s.agent}: ${cap(s.error, 160)}`);
    if (errs.length) out.push({ title: "Recent step errors", body: errs.join("\n") });
    const appr = await rows(db.from("workflow_approval_queue").select("title, agent_slug, requested_at").eq("org_id", org).eq("status", "pending_approval").order("requested_at").limit(20));
    out.push({ title: "Waiting on the owner (approvals)", body: appr.length ? appr.map((a) => `- ${a.agent_slug ?? "workflow"}: ${cap(a.title, 120)} (since ${String(a.requested_at).slice(0, 10)})`).join("\n") : "nothing pending" });
  }
  if (playbookSlug.startsWith("marketing-weekly")) {
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const delivered = await rows(db.from("projects").select("name, description, brand, stage_changed_at, project_stages(name)").eq("org_id", org).gte("updated_at", since).limit(15));
    out.push({ title: "Recently active projects (anonymise clients in anything public)", body: delivered.length ? delivered.map((p) => `- ${cap(p.name, 80)} [${p.project_stages?.name ?? "?"}]: ${cap(p.description, 300)}`).join("\n") : "none" });
  }
  if (playbookSlug === "marketing-monthly-visibility") {
    for (const [brand, site] of Object.entries(BRAND_SITES)) out.push(await siteSnapshot(site, BRAND_NAMES[brand], fetcher));
  }
  return out;
}

/** Fetch a site's home page + sitemap + robots + llms.txt (only the configured brand sites), reduced to SEO-relevant text. */
export async function siteSnapshot(site: string, label: string, fetcher: typeof fetch): Promise<Section> {
  const get = async (path: string) => {
    try {
      const r = await fetcher(`${site}${path}`, { headers: { "user-agent": "Orion-Factory/1.0" }, signal: AbortSignal.timeout(6000), redirect: "follow" });
      return { status: r.status, text: r.ok ? (await r.text()).slice(0, 200_000) : "" };
    } catch (e) { return { status: 0, text: `fetch failed: ${(e as Error).message}` }; }
  };
  const [home, sitemap, robots, llms] = await Promise.all([get("/"), get("/sitemap.xml"), get("/robots.txt"), get("/llms.txt")]);
  const pick = (re: RegExp, s: string, n = 20) => [...s.matchAll(re)].slice(0, n).map((m) => m[1].replace(/\s+/g, " ").trim()).filter(Boolean);
  const h = home.text;
  const body = [
    `Home: HTTP ${home.status}`,
    `title: ${pick(/<title[^>]*>([\s\S]*?)<\/title>/gi, h, 1).join("") || "(none)"}`,
    `meta description: ${pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/gi, h, 1).join("") || "(none)"}`,
    `h1: ${pick(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, h, 3).map((x) => x.replace(/<[^>]+>/g, "")).join(" | ") || "(none)"}`,
    `h2: ${pick(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, h, 15).map((x) => x.replace(/<[^>]+>/g, "")).join(" | ") || "(none)"}`,
    `json-ld types: ${pick(/"@type"\s*:\s*"([^"]+)"/g, h, 20).join(", ") || "(none)"}`,
    `visible text (start): ${cap(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 2500)}`,
    `sitemap.xml: HTTP ${sitemap.status}, ${(sitemap.text.match(/<loc>/g) ?? []).length} URLs: ${pick(/<loc>([^<]+)<\/loc>/g, sitemap.text, 40).join(" ")}`,
    `robots.txt: HTTP ${robots.status}: ${cap(robots.text, 600)}`,
    `llms.txt: HTTP ${llms.status}${llms.status === 200 ? `: ${cap(llms.text, 800)}` : ""}`,
  ].join("\n");
  return { title: `Website snapshot: ${label} (${site})`, untrusted: true, body };
}

export async function buildContext(db: SupabaseClient, run: RunRow, playbookSlug: string, stepRunId: string, fetcher: typeof fetch = fetch): Promise<Section[]> {
  const out: Section[] = [];
  if (run.brand) out.push({ title: "Brand", body: BRAND_NAMES[run.brand] ?? run.brand });
  if (run.subject_type === "opportunity") out.push(...await opportunitySections(db, run));
  else if (run.subject_type === "project") out.push(...await projectSections(db, run));
  else out.push(...await orgSections(db, run, playbookSlug, fetcher));
  const prior = await priorSteps(db, run.id, stepRunId);
  if (prior) out.push(prior);
  return out;
}

export function renderSections(sections: Section[], maxChars = 45_000): string {
  let s = sections.map((x) => x.untrusted
    ? `## ${x.title}\n<untrusted_data>\n${x.body}\n</untrusted_data>`
    : `## ${x.title}\n${x.body}`).join("\n\n");
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\n…(context truncated)`;
  return s;
}
