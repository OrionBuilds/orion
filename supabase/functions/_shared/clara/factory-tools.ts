/**
 * Clara's factory tools: run the company's playbooks from a sentence.
 *
 *   create_deal     open a deal for a contact in a sales pipeline (brand from the contact)
 *   move_deal       move a deal to a stage (that stage's playbook steps queue automatically)
 *   move_project    same for a delivery project
 *   start_playbook  attach a playbook to a deal/project by hand
 *   factory_status  what the factory is doing: live plays, steps, what waits on the owner
 *
 * All owner-only. The owner asking is the approval for these internal moves (nothing leaves the
 * company here); outward work the playbooks produce still waits in the approval queue.
 */
import type { OwnerCtx, OwnerTool, ToolResult } from "./owner-tools.ts";
import { searchContacts } from "./contacts-search.ts";
import { asDetail } from "./owner-read-tools.ts";
import { BRAND_KEYS } from "../brands.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Best stage match by name within one pipeline: exact, then starts-with, then contains. */
export function pickStage<T extends { name: string }>(stages: T[], want: string): T | null | T[] {
  const w = norm(want);
  if (!w) return null;
  const exact = stages.filter((s) => norm(s.name) === w);
  if (exact.length === 1) return exact[0];
  const starts = stages.filter((s) => norm(s.name).startsWith(w));
  if (starts.length === 1) return starts[0];
  const has = stages.filter((s) => norm(s.name).includes(w));
  if (has.length === 1) return has[0];
  return has.length > 1 ? has : starts.length > 1 ? starts : null;
}

export async function findDeal(c: OwnerCtx, q: string): Promise<{ deal: Json } | ToolResult> {
  if (UUID_RE.test(q)) {
    const { data } = await c.db.from("opportunities").select("id, name, pipeline_id, stage_id, status, contact_id, brand").eq("org_id", c.orgId).eq("id", q).maybeSingle();
    return data ? { deal: data as Json } : { ok: true, line: "I can't find that deal." };
  }
  const { data: byName } = await c.db.from("opportunities").select("id, name, pipeline_id, stage_id, status, contact_id, brand").eq("org_id", c.orgId).eq("status", "open").ilike("name", `%${q.replace(/[%_]/g, "")}%`).limit(6);
  let deals = (byName ?? []) as Json[];
  if (!deals.length) {
    const people = await searchContacts(c.db, c.orgId, q, 4);
    if (people.length) {
      const { data } = await c.db.from("opportunities").select("id, name, pipeline_id, stage_id, status, contact_id, brand").eq("org_id", c.orgId).eq("status", "open").in("contact_id", people.map((p) => p.id)).limit(6);
      deals = (data ?? []) as Json[];
    }
  }
  if (deals.length === 1) return { deal: deals[0] };
  if (deals.length > 1) return { ok: false, clarify: true, line: `Which deal: ${deals.slice(0, 5).map((d) => d.name ?? "unnamed").join("; ")}?` };
  return { ok: true, line: `I can't find an open deal matching "${q}".` };
}

const createDeal: OwnerTool = {
  name: "create_deal",
  ownerOnly: true,
  description: "Open a new deal (opportunity) for a contact. pipeline: Inbound (default), Outbound or Government. The brand comes from the contact unless given. delivery: where the project goes once signed (engineering = build project, caio = CAIO engagement). The pipeline's playbook starts at the first stage.",
  input_schema: {
    type: "object", required: ["contact"],
    properties: {
      contact: { type: "string", description: "Contact name or email" }, name: { type: "string", description: "Deal name; default '<Company> - <need>'" },
      pipeline: { type: "string" }, value: { type: "number" }, brand: { type: "string", enum: BRAND_KEYS },
      delivery: { type: "string", enum: ["engineering", "caio"] }, notes: { type: "string" },
    },
  },
  async run(c, a) {
    const people = await searchContacts(c.db, c.orgId, str(a.contact), 5);
    if (people.length !== 1) return { ok: false, clarify: true, line: people.length ? `Which ${str(a.contact)}: ${people.slice(0, 4).map((p) => `${p.name}${p.company ? ` (${p.company})` : ""}`).join(", ")}?` : `I don't have a contact called "${str(a.contact)}". Add them first?` };
    const person = people[0];
    const pipeName = str(a.pipeline) || "Inbound";
    const { data: pipes } = await c.db.from("pipelines").select("id, name").eq("org_id", c.orgId);
    const pipe = pickStage((pipes ?? []) as { id: string; name: string }[], pipeName);
    if (!pipe || Array.isArray(pipe)) return { ok: false, clarify: true, line: `Which pipeline: ${((pipes ?? []) as Json[]).map((p) => p.name).join(", ")}?` };
    const { data: stages } = await c.db.from("pipeline_stages").select("id, name, sort_order").eq("pipeline_id", pipe.id).order("sort_order").limit(1);
    const first = ((stages ?? []) as Json[])[0];
    if (!first) return { ok: false, line: `The ${pipe.name} pipeline has no stages.` };
    let projectPipelineId: string | null = null;
    if (str(a.delivery)) {
      const { data: pp } = await c.db.from("project_pipelines").select("id, name").eq("org_id", c.orgId);
      const hit = ((pp ?? []) as Json[]).find((p) => norm(p.name).includes(str(a.delivery) === "caio" ? "caio" : "engineering"));
      projectPipelineId = hit?.id ?? null;
    }
    const name = (str(a.name) || `${person.company || person.name} - new deal`).slice(0, 200);
    const { data, error } = await c.db.from("opportunities").insert({
      org_id: c.orgId, contact_id: person.id, pipeline_id: pipe.id, stage_id: first.id, status: "open",
      name, description: str(a.notes) || null, value_amount: typeof a.value === "number" ? a.value : null, currency: "USD",
      brand: str(a.brand) || null, project_pipeline_id: projectPipelineId, assigned_user_id: c.ownerUserId, created_by: c.ownerUserId, source: "clara",
    }).select("id, brand").maybeSingle();
    if (error || !data) return { ok: false, line: `I couldn't open the deal: ${error?.message ?? "no row returned"}.` };
    return { ok: true, line: `Opened "${name}" for ${person.name} in ${pipe.name} (${first.name}), brand ${(data as Json).brand}. The ${pipe.name} play has started.`, detail: asDetail({ id: (data as Json).id, link: `/opportunities` }) };
  },
};

const moveDeal: OwnerTool = {
  name: "move_deal",
  ownerOnly: true,
  description: "Move a deal to a stage by name (e.g. 'qualified', 'discovery completed', 'proposal sent', 'closed lost'). The new stage's playbook steps queue automatically. Use won/lost words for closing; give lost_reason when lost.",
  input_schema: { type: "object", required: ["deal", "stage"], properties: { deal: { type: "string", description: "Deal name, contact name or id" }, stage: { type: "string" }, lost_reason: { type: "string" } } },
  async run(c, a) {
    const f = await findDeal(c, str(a.deal));
    if (!("deal" in f)) return f;
    const deal = f.deal;
    const { data: stages } = await c.db.from("pipeline_stages").select("id, name, sort_order").eq("pipeline_id", deal.pipeline_id).order("sort_order");
    const s = pickStage((stages ?? []) as { id: string; name: string }[], str(a.stage));
    if (!s) return { ok: false, clarify: true, line: `Which stage: ${((stages ?? []) as Json[]).map((x) => x.name).join(", ")}?` };
    if (Array.isArray(s)) return { ok: false, clarify: true, line: `Which stage: ${s.map((x) => x.name).join(", ")}?` };
    const lost = /lost/i.test(s.name), won = /won/i.test(s.name);
    const patch: Json = { stage_id: s.id, stage_changed_at: c.now().toISOString() };
    if (won || lost) Object.assign(patch, { status: won ? "won" : "lost", closed_at: c.now().toISOString(), ...(lost && str(a.lost_reason) ? { lost_reason: str(a.lost_reason).slice(0, 500) } : {}) });
    const { error } = await c.db.from("opportunities").update(patch).eq("org_id", c.orgId).eq("id", deal.id);
    if (error) return { ok: false, line: `I couldn't move the deal: ${error.message}.` };
    return { ok: true, line: `Moved "${deal.name ?? "the deal"}" to ${s.name}. That stage's playbook steps are queued.` };
  },
};

const moveProject: OwnerTool = {
  name: "move_project",
  ownerOnly: true,
  description: "Move a delivery project to a stage by name (e.g. 'kickoff', 'qa', 'client review', 'delivered'). The stage's playbook steps queue automatically.",
  input_schema: { type: "object", required: ["project", "stage"], properties: { project: { type: "string" }, stage: { type: "string" } } },
  async run(c, a) {
    const q = str(a.project);
    const { data: found } = UUID_RE.test(q)
      ? await c.db.from("projects").select("id, name, pipeline_id").eq("org_id", c.orgId).eq("id", q).limit(1)
      : await c.db.from("projects").select("id, name, pipeline_id").eq("org_id", c.orgId).ilike("name", `%${q.replace(/[%_]/g, "")}%`).limit(6);
    const projects = (found ?? []) as Json[];
    if (projects.length !== 1) return { ok: false, clarify: true, line: projects.length ? `Which project: ${projects.map((p) => p.name).join("; ")}?` : `I can't find a project matching "${q}".` };
    const p = projects[0];
    const { data: stages } = await c.db.from("project_stages").select("id, name, sort_order").eq("pipeline_id", p.pipeline_id).order("sort_order");
    const s = pickStage((stages ?? []) as { id: string; name: string }[], str(a.stage));
    if (!s || Array.isArray(s)) return { ok: false, clarify: true, line: `Which stage: ${(Array.isArray(s) ? s : (stages ?? []) as Json[]).map((x) => x.name).join(", ")}?` };
    const { error } = await c.db.from("projects").update({ stage_id: s.id, stage_changed_at: c.now().toISOString() }).eq("org_id", c.orgId).eq("id", p.id);
    if (error) return { ok: false, line: `I couldn't move the project: ${error.message}.` };
    return { ok: true, line: `Moved ${p.name} to ${s.name}. That stage's playbook steps are queued.` };
  },
};

const startPlaybook: OwnerTool = {
  name: "start_playbook",
  ownerOnly: true,
  description: "Attach a playbook to a deal or project by hand (it normally starts with its pipeline), or run a scheduled play now (ops-weekly-review, finance-weekly, finance-monthly, marketing-*, outbound-weekly-review; no subject needed). playbook is a slug from factory_status.",
  input_schema: { type: "object", required: ["playbook"], properties: { playbook: { type: "string" }, subject: { type: "string", description: "Deal or project name or id (not for scheduled plays)" } } },
  async run(c, a) {
    const { data: pb } = await c.db.from("playbooks").select("id, slug, name, applies_to").eq("org_id", c.orgId).eq("slug", str(a.playbook)).eq("enabled", true).maybeSingle();
    if (!pb) return { ok: false, clarify: true, line: `There's no enabled playbook "${str(a.playbook)}". Ask me for the factory status to see them.` };
    const type = (pb as Json).applies_to as string;
    let id: string | null = null;
    if (type === "org") {
      // A scheduled play run now ("do the weekly review now"); its normal schedule is unchanged.
    } else if (type === "opportunity") {
      const f = await findDeal(c, str(a.subject));
      if (!("deal" in f)) return f;
      id = f.deal.id;
    } else {
      const { data } = await c.db.from("projects").select("id, name").eq("org_id", c.orgId).ilike("name", `%${str(a.subject).replace(/[%_]/g, "")}%`).limit(3);
      const ps = (data ?? []) as Json[];
      if (ps.length !== 1) return { ok: false, clarify: true, line: ps.length ? `Which project: ${ps.map((p) => p.name).join("; ")}?` : `I can't find a project matching "${str(a.subject)}".` };
      id = ps[0].id;
    }
    // factory_start (service role): factory_start_playbook checks auth.uid(), which is empty here.
    const { data: run, error } = await c.db.rpc("factory_start", { p_playbook_id: (pb as Json).id, p_subject_type: type, p_subject_id: id });
    if (error) return { ok: false, line: `I couldn't start it: ${error.message}.` };
    if (!run) return { ok: false, line: `${(pb as Json).name} doesn't apply to that ${type === "opportunity" ? "deal" : "project"} (brand or type mismatch).` };
    return { ok: true, line: type === "org" ? `Running ${(pb as Json).name} now; results land in the Factory board and your approvals.` : `Started ${(pb as Json).name}. Its current-stage steps are queued.` };
  },
};

const factoryStatus: OwnerTool = {
  name: "factory_status",
  readOnly: true, ownerOnly: true,
  description: "What the factory is doing: live playbook runs per deal/project/schedule, each step's status (queued, running, needs_approval, done, escalated...), gates, and what waits on the owner. Also lists the playbooks. about: filter by deal/project name.",
  input_schema: { type: "object", properties: { about: { type: "string" } } },
  async run(c, a) {
    const { data: runs } = await c.db.from("playbook_runs").select("id, subject_type, subject_id, brand, status, started_at, playbooks(slug, name)").eq("org_id", c.orgId).eq("status", "active").order("started_at", { ascending: false }).limit(60);
    const ids = ((runs ?? []) as Json[]).map((r) => r.id);
    const { data: steps } = ids.length
      ? await c.db.from("playbook_step_runs").select("run_id, status, agent, stage_name, error, playbook_steps(title, required)").in("run_id", ids).limit(600)
      : { data: [] };
    const subjects = new Map<string, string>();
    for (const t of ["opportunities", "projects"] as const) {
      const sid = ((runs ?? []) as Json[]).filter((r) => r.subject_type === (t === "opportunities" ? "opportunity" : "project")).map((r) => r.subject_id);
      if (sid.length) for (const r of ((await c.db.from(t).select("id, name").in("id", sid)).data ?? []) as Json[]) subjects.set(r.id, r.name);
    }
    const about = norm(str(a.about));
    const list = ((runs ?? []) as Json[]).map((r) => {
      const st = ((steps ?? []) as Json[]).filter((s) => s.run_id === r.id);
      return {
        playbook: r.playbooks?.name, subject: r.subject_id ? subjects.get(r.subject_id) ?? r.subject_type : "scheduled", brand: r.brand,
        waiting_on_owner: st.filter((s) => s.status === "needs_approval").map((s) => s.playbook_steps?.title),
        escalated: st.filter((s) => s.status === "escalated").map((s) => `${s.playbook_steps?.title}: ${String(s.error ?? "").slice(0, 100)}`),
        in_progress: st.filter((s) => ["queued", "running", "dispatched"].includes(s.status)).map((s) => `${s.playbook_steps?.title} (${s.agent})`),
        done: st.filter((s) => s.status === "done").length, total: st.length,
      };
    }).filter((r) => !about || norm(String(r.subject)).includes(about));
    const { data: pbs } = await c.db.from("playbooks").select("slug, name, applies_to, cadence, enabled").eq("org_id", c.orgId).order("slug");
    const waiting = list.reduce((n, r) => n + r.waiting_on_owner.length, 0), esc = list.reduce((n, r) => n + r.escalated.length, 0);
    return { ok: true, line: `${list.length} live play${list.length === 1 ? "" : "s"}: ${waiting} waiting on you, ${esc} escalated.`, detail: asDetail({ runs: list.slice(0, 25), playbooks: pbs ?? [] }) };
  },
};

export const FACTORY_TOOLS: OwnerTool[] = [createDeal, moveDeal, moveProject, startPlaybook, factoryStatus];
