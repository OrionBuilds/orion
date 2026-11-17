/**
 * "Needs your input": which facts and registers would unblock which unresolved placeholders, and the
 * caio_input_requests rows that surface it. Pure computation plus one db sync (service role).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { PlaceholderDef } from "./hydrate.ts";

export interface NeedInput { kind: "fact" | "register"; key: string; label: string; placeholders: string[] }

export interface ReadinessInput {
  unresolved: { name: string; resolver: string }[];
  defs: PlaceholderDef[];
  feeds: string[];
  templateNumber: number;
  /** All facts of the engagement (any status). */
  facts: { fact_key: string; status: string }[];
  /** Register keys that already have at least one record in scope. */
  registersWithRecords: Set<string>;
  factDefs: { fact_key: string; label: string; templates: number[] }[];
  registerTitles: Record<string, string>;
}

/** Facts and registers that would fill (or help fill) this document's open placeholders. */
export function computeNeeds(i: ReadinessInput): NeedInput[] {
  const defs = new Map(i.defs.map((d) => [d.name, d]));
  const factLabel = new Map(i.factDefs.map((f) => [f.fact_key, f.label]));
  const confirmed = new Set(i.facts.filter((f) => f.status === "confirmed").map((f) => f.fact_key));
  const needs = new Map<string, NeedInput>();
  const add = (kind: "fact" | "register", key: string, label: string, placeholder: string) => {
    const k = `${kind}:${key}`;
    const n = needs.get(k) ?? { kind, key, label, placeholders: [] };
    if (!n.placeholders.includes(placeholder)) n.placeholders.push(placeholder);
    needs.set(k, n);
  };
  const rank = (reg: string) => { const x = i.feeds.indexOf(reg); return x < 0 ? 999 : x; };
  let llmOpen = false;

  for (const u of i.unresolved) {
    const d = defs.get(u.name);
    if (!d) continue;
    if (d.resolver === "fact" && !confirmed.has(d.target)) {
      add("fact", d.target, factLabel.get(d.target) ?? d.target, u.name);
    } else if (d.resolver === "register") {
      const cands = d.target.split(",").map((t) => t.trim().split(".")[0]).filter(Boolean)
        .map((reg, idx) => ({ reg, idx })).sort((a, b) => rank(a.reg) - rank(b.reg) || a.idx - b.idx);
      if (!cands.length) continue;
      // a register that already has records is not the blocker for a missing field; the owner completes the record
      const reg = cands.find((c) => !i.registersWithRecords.has(c.reg))?.reg ?? cands[0].reg;
      add("register", reg, i.registerTitles[reg] ?? reg, u.name);
    } else if (d.resolver === "llm") {
      llmOpen = true;
    }
  }
  // narrative slots are drafted from facts and interviews: ask for the unconfirmed facts this template is known to use
  if (llmOpen) {
    for (const f of i.factDefs) {
      if (f.templates.includes(i.templateNumber) && !confirmed.has(f.fact_key)) add("fact", f.fact_key, f.label, "(narrative)");
    }
  }
  return [...needs.values()];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Create / refresh / resolve the engagement's input requests after one document was generated. */
export async function syncInputRequests(db: SupabaseClient, o: {
  orgId: string; engagementId: string; templateNumber: number; templateTitle: string;
  needs: NeedInput[];
  templateTitles: Record<number, string>;
  facts: { fact_key: string; status: string }[];
  registersWithRecords: Set<string>;
}): Promise<void> {
  const { data } = await db.from("caio_input_requests").select("*").eq("engagement_id", o.engagementId);
  const existing = (data ?? []) as { id: string; kind: string; key: string; label: string; why: string; blocks_templates: number[]; status: string }[];
  const byKey = new Map(existing.map((r) => [`${r.kind}:${r.key}`, r]));
  const why = (blocks: number[]) =>
    `needed by ${[...blocks].sort((a, b) => a - b).map((n) => `${pad2(n)} ${o.templateTitles[n] ?? ""}`.trim()).join(", ")}`;
  const touched = new Set<string>();

  for (const n of o.needs) {
    const k = `${n.kind}:${n.key}`;
    touched.add(k);
    const cur = byKey.get(k);
    const blocks = [...new Set([...(cur?.blocks_templates ?? []), o.templateNumber])].sort((a, b) => a - b);
    if (cur?.status === "dismissed") { continue; }   // the owner said no; never reopen it
    await db.from("caio_input_requests").upsert({
      org_id: o.orgId, engagement_id: o.engagementId, kind: n.kind, key: n.key, label: cur?.label || n.label,
      why: why(blocks), blocks_templates: blocks, status: "open", resolved_at: null,
    }, { onConflict: "engagement_id,kind,key" });
  }

  const confirmed = new Set(o.facts.filter((f) => f.status === "confirmed").map((f) => f.fact_key));
  for (const r of existing) {
    const k = `${r.kind}:${r.key}`;
    if (r.status !== "open") continue;
    const satisfied = r.kind === "fact" ? confirmed.has(r.key) : o.registersWithRecords.has(r.key) && !touched.has(k);
    if (satisfied) {
      await db.from("caio_input_requests").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", r.id);
      continue;
    }
    // this document no longer needs it
    if (!touched.has(k) && r.blocks_templates.includes(o.templateNumber)) {
      const blocks = r.blocks_templates.filter((t) => t !== o.templateNumber);
      if (blocks.length) await db.from("caio_input_requests").update({ blocks_templates: blocks, why: why(blocks) }).eq("id", r.id);
      else await db.from("caio_input_requests").update({ blocks_templates: [], status: "resolved", resolved_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
}
