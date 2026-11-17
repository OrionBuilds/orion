/**
 * CAIO engagement status, computed from the CAIO tables (migrations 20261105*). Pure over a service-role client:
 * Clara's `caio_status` tool and the factory context both use it, so the owner hears the same numbers the module shows.
 * Everything here is read-only. Nothing is guessed: a gate whose conditions are unmet says which ones, a required
 * template with no approved document is named.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const CLOSED = new Set(["closed", "done", "retired", "superseded", "revoked", "rejected", "not applicable", "cancelled", "expired", "released", "rolled back", "decided", "attended", "excused", "missed"]);
export const isClosed = (status: string | null | undefined) => CLOSED.has(String(status ?? "").toLowerCase());

export interface EngagementStatus {
  id: string; code: string; client: string; project_id: string; status: string; portal_enabled: boolean; kickoff_date: string;
  next_gate: { label: string; due: string; days: number; status: string; met: number; total: number; unmet: string[]; templates_missing: number[] } | null;
  counts: Record<string, number>;
  overdue_actions: number; exceptions_expiring_30d: number; exceptions_expired: number; open_incidents: number; reviews_overdue: number;
  documents: { draft: number; in_review: number; approved: number; review_overdue: number };
  attention: string[];
}

const days = (iso: string, today: Date) => Math.round((Date.parse(iso.slice(0, 10)) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000);

export async function caioStatus(db: SupabaseClient, orgId: string, opts: { client?: string; projectId?: string; now?: Date } = {}): Promise<EngagementStatus[]> {
  const today = opts.now ?? new Date();
  let q = db.from("caio_engagements").select("id, engagement_code, client_legal_name, project_id, status, portal_enabled, kickoff_date").eq("org_id", orgId).neq("status", "completed");
  if (opts.projectId) q = q.eq("project_id", opts.projectId);
  const { data: engs } = await q.order("kickoff_date", { ascending: false }).limit(50);
  let list = (engs ?? []) as Json[];
  const want = (opts.client ?? "").toLowerCase().trim();
  if (want) list = list.filter((e) => `${e.client_legal_name} ${e.engagement_code}`.toLowerCase().includes(want));
  if (!list.length) return [];
  const ids = list.map((e) => e.id);

  const [{ data: recs }, { data: gates }, { data: docs }, { data: defs }, { data: regs }] = await Promise.all([
    db.from("caio_records").select("engagement_id, register_key, record_key, status, due_date").in("engagement_id", ids).limit(5000),
    db.from("caio_gates").select("engagement_id, gate_key, due_date, status, conditions").in("engagement_id", ids),
    db.from("caio_documents").select("engagement_id, template_number, status, next_review, title").in("engagement_id", ids).limit(2000),
    db.from("caio_gate_defs").select("gate_key, label, sort, required_templates"),
    db.from("caio_registers").select("register_key, title"),
  ]);
  const gateDef = new Map(((defs ?? []) as Json[]).map((d) => [d.gate_key, d]));
  const regTitle = new Map(((regs ?? []) as Json[]).map((r) => [r.register_key, r.title]));

  return list.map((e): EngagementStatus => {
    const myRecs = ((recs ?? []) as Json[]).filter((r) => r.engagement_id === e.id);
    const myDocs = ((docs ?? []) as Json[]).filter((d) => d.engagement_id === e.id);
    const counts: Record<string, number> = {};
    for (const r of myRecs) counts[r.register_key] = (counts[r.register_key] ?? 0) + 1;
    const open = (r: Json) => !isClosed(r.status);
    const overdue = (r: Json) => r.due_date && days(r.due_date, today) < 0;
    const attention: string[] = [];
    const title = (r: Json) => `${regTitle.get(r.register_key) ?? r.register_key} ${r.record_key}`;

    const overdueActions = myRecs.filter((r) => r.register_key === "actions" && open(r) && overdue(r));
    const expiring = myRecs.filter((r) => r.register_key === "exceptions" && open(r) && r.due_date && days(r.due_date, today) >= 0 && days(r.due_date, today) <= 30);
    const expired = myRecs.filter((r) => r.register_key === "exceptions" && String(r.status ?? "").toLowerCase() === "approved" && overdue(r));
    const incidents = myRecs.filter((r) => r.register_key === "incidents" && open(r));
    const reviews = myRecs.filter((r) => !["actions", "exceptions"].includes(r.register_key) && open(r) && overdue(r));
    for (const r of overdueActions.slice(0, 3)) attention.push(`${title(r)} overdue since ${r.due_date}`);
    for (const r of expired.slice(0, 3)) attention.push(`${title(r)} expired ${r.due_date} but is still marked approved`);
    for (const r of incidents.slice(0, 2)) attention.push(`${title(r)} is still open`);
    for (const r of reviews.slice(0, 3)) attention.push(`${title(r)} review overdue since ${r.due_date}`);

    const approvedNumbers = new Set(myDocs.filter((d) => d.status === "approved").map((d) => d.template_number));
    const myGates = ((gates ?? []) as Json[]).filter((g) => g.engagement_id === e.id && ["open", "remediation"].includes(g.status)).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    let next_gate: EngagementStatus["next_gate"] = null;
    if (myGates[0]) {
      const g = myGates[0];
      const conds = (Array.isArray(g.conditions) ? g.conditions : []) as Json[];
      const required = ((gateDef.get(g.gate_key)?.required_templates ?? []) as number[]);
      next_gate = {
        label: gateDef.get(g.gate_key)?.label ?? g.gate_key, due: g.due_date, days: days(g.due_date, today), status: g.status,
        met: conds.filter((c) => c.met).length, total: conds.length, unmet: conds.filter((c) => !c.met).map((c) => String(c.text)).slice(0, 8),
        templates_missing: required.filter((n) => !approvedNumbers.has(n)),
      };
      if (next_gate.days <= 14) attention.push(`${next_gate.label} gate ${next_gate.days < 0 ? `was due ${g.due_date}` : `is due ${g.due_date}`}: ${next_gate.met}/${next_gate.total} conditions met, ${next_gate.templates_missing.length} required document(s) not yet approved`);
    }
    const docCount = (s: string) => myDocs.filter((d) => d.status === s).length;
    const reviewOverdue = myDocs.filter((d) => d.status === "approved" && d.next_review && days(d.next_review, today) < 0).length;
    if (reviewOverdue) attention.push(`${reviewOverdue} approved document(s) are past their review date`);
    return {
      id: e.id, code: e.engagement_code, client: e.client_legal_name, project_id: e.project_id, status: e.status, portal_enabled: e.portal_enabled, kickoff_date: e.kickoff_date,
      next_gate, counts, overdue_actions: overdueActions.length, exceptions_expiring_30d: expiring.length, exceptions_expired: expired.length,
      open_incidents: incidents.length, reviews_overdue: reviews.length,
      documents: { draft: docCount("draft"), in_review: docCount("in_review"), approved: docCount("approved"), review_overdue: reviewOverdue }, attention,
    };
  });
}

/** One-paragraph version for prompts and spoken answers. */
export function summarize(s: EngagementStatus): string {
  const g = s.next_gate;
  const gate = g ? `next gate ${g.label} ${g.days < 0 ? `overdue ${-g.days}d` : `in ${g.days}d`} (${g.met}/${g.total} conditions)` : "no open gate";
  return `${s.client} (${s.code}): ${gate}; ${s.overdue_actions} overdue action(s), ${s.open_incidents} open incident(s), ${s.exceptions_expired + s.exceptions_expiring_30d} exception(s) expiring or expired, ${s.documents.approved} approved document(s)`;
}
