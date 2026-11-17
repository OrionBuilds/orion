/**
 * Clara's CAIO tools:
 *   caio_status       where each Fractional CAIO client stands (gates, overdue items, documents). Read-only.
 *   caio_inbox        what is waiting: suggestions from interviews, unconfirmed facts, sources and meetings needing the owner. Read-only.
 *   caio_accept       accept suggestions (by id, or all high-confidence ones from one source). Writes through the validated SQL path.
 *   caio_needs_input  the open "needs your input" items, ranked by how many documents each blocks. Read-only.
 * All owner-only. The status numbers come from the same function the CAIO module uses (_shared/caio/status.ts),
 * so what Clara says matches what the owner sees on the page.
 */
import type { OwnerCtx, OwnerTool } from "./owner-tools.ts";
import { asDetail } from "./owner-read-tools.ts";
import { caioStatus, summarize } from "../caio/status.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Active engagements of the org, optionally narrowed by client name / engagement code. */
async function engagementsFor(c: OwnerCtx, client: string): Promise<Json[]> {
  const { data } = await c.db.from("caio_engagements").select("id, engagement_code, client_legal_name, status").eq("org_id", c.orgId).neq("status", "completed").limit(50);
  const want = client.toLowerCase();
  return ((data ?? []) as Json[]).filter((e) => !want || `${e.client_legal_name} ${e.engagement_code}`.toLowerCase().includes(want));
}

export const caioStatusTool: OwnerTool = {
  name: "caio_status",
  readOnly: true, ownerOnly: true,
  description: "Where the owner's Fractional CAIO clients stand: per engagement the next delivery gate (Day 30/60/90, Month 6/12) with its unmet acceptance conditions and the required documents not yet approved, overdue actions, expiring or expired exceptions, open incidents, overdue register reviews, and document counts. Use for 'how is Acme's CAIO engagement', 'what's due for the day-30 gate', 'what needs attention across my CAIO clients'. Give client (name or engagement code) to focus on one; omit for all.",
  input_schema: { type: "object", properties: { client: { type: "string" } } },
  async run(c, a) {
    const list = await caioStatus(c.db, c.orgId, { client: str(a.client), now: c.now() });
    if (!list.length) return { ok: true, line: str(a.client) ? `I don't see a CAIO engagement matching "${str(a.client)}".` : "There are no active CAIO engagements yet." };
    const attention = list.reduce((n, s) => n + s.attention.length, 0);
    return {
      ok: true,
      line: list.length === 1 ? summarize(list[0]) + "." : `${list.length} active CAIO engagements, ${attention} thing(s) needing attention.`,
      detail: asDetail(list.map((s) => ({ ...s, summary: summarize(s) }))),
    };
  },
};

export const caioInboxTool: OwnerTool = {
  name: "caio_inbox",
  readOnly: true, ownerOnly: true,
  description: "What is waiting for the owner in the CAIO module: suggestions (proposals) extracted from interviews per source, facts not yet confirmed, uploaded sources held for review, OS meetings that need to be linked to a client, and open 'needs your input' requests. Give client (name or engagement code) for one engagement; omit for all. Use for 'what is in my CAIO inbox', 'anything waiting from the Acme interviews'.",
  input_schema: { type: "object", properties: { client: { type: "string" } } },
  async run(c, a) {
    const client = str(a.client);
    const engs = await engagementsFor(c, client);
    if (!engs.length) return { ok: true, line: client ? `I don't see a CAIO engagement matching "${client}".` : "There are no active CAIO engagements yet." };
    const ids = engs.map((e) => e.id);
    const [{ data: props }, { data: facts }, { data: srcs }, { data: links }, { data: reqs }] = await Promise.all([
      c.db.from("caio_proposals").select("engagement_id, source_id, confidence, flags").in("engagement_id", ids).eq("status", "proposed").limit(2000),
      c.db.from("caio_facts").select("engagement_id, fact_key").in("engagement_id", ids).eq("status", "proposed").limit(1000),
      c.db.from("caio_sources").select("id, engagement_id, title, process_status").in("engagement_id", ids).limit(1000),
      c.db.from("caio_meeting_links").select("meeting_transcription_id, state").eq("org_id", c.orgId).eq("state", "needs_link").limit(200),
      c.db.from("caio_input_requests").select("engagement_id").in("engagement_id", ids).eq("status", "open").limit(1000),
    ]);
    const title = new Map(((srcs ?? []) as Json[]).map((s) => [s.id, s.title as string]));
    const per = engs.map((e) => {
      const mine = ((props ?? []) as Json[]).filter((p) => p.engagement_id === e.id);
      const bySource = new Map<string, { total: number; high: number }>();
      for (const p of mine) {
        const x = bySource.get(p.source_id) ?? { total: 0, high: 0 };
        x.total++; if (p.confidence === "high") x.high++;
        bySource.set(p.source_id, x);
      }
      return {
        client: e.client_legal_name, code: e.engagement_code,
        proposals: [...bySource].map(([sid, x]) => ({ source: title.get(sid) ?? "a source", source_id: sid, open: x.total, high_confidence: x.high })),
        proposals_open: mine.length,
        unconfirmed_facts: ((facts ?? []) as Json[]).filter((f) => f.engagement_id === e.id).length,
        sources_needing_review: ((srcs ?? []) as Json[]).filter((s) => s.engagement_id === e.id && s.process_status === "needs_review").map((s) => s.title),
        input_requests_open: ((reqs ?? []) as Json[]).filter((r) => r.engagement_id === e.id).length,
      };
    });
    const meetings = ((links ?? []) as Json[]).length;
    const totals = per.reduce((t, p) => ({ p: t.p + p.proposals_open, f: t.f + p.unconfirmed_facts, s: t.s + p.sources_needing_review.length, r: t.r + p.input_requests_open }), { p: 0, f: 0, s: 0, r: 0 });
    const parts = [
      totals.p ? plural(totals.p, "suggestion") + " to review" : "", totals.f ? plural(totals.f, "unconfirmed fact") : "",
      totals.s ? plural(totals.s, "source") + " held for review" : "", meetings ? plural(meetings, "meeting") + " to link to a client" : "",
      totals.r ? plural(totals.r, "open input request") : "",
    ].filter(Boolean);
    const who = per.length === 1 ? `${per[0].client}: ` : "";
    return {
      ok: true,
      line: parts.length ? `${who}${parts.join(", ")}.` : `${who}nothing is waiting in the CAIO inbox.`,
      detail: asDetail({ engagements: per, meetings_needing_link: meetings }, true),
    };
  },
};

const BULK_EXCLUDED_FLAGS = ["injection_suspected", "legal_candidate", "public_research"];

export const caioAcceptTool: OwnerTool = {
  name: "caio_accept",
  ownerOnly: true,
  description: "Accept CAIO suggestions (proposals extracted from interviews) so they become confirmed facts or register records. Either give proposal_ids, or give source (the source's id or part of its title) to accept ALL its high-confidence open suggestions. Suggestions flagged for review (legal candidates, public research, instruction-like source text) are never accepted in bulk: the owner must name them by id. For a bulk accept, set confirm=true ONLY when the owner explicitly told you to accept them; otherwise leave it out and I will ask first. Reports what was written and what failed validation.",
  input_schema: {
    type: "object",
    properties: {
      proposal_ids: { type: "array", items: { type: "string" } },
      source: { type: "string", description: "Source id or title fragment; accepts its high-confidence open suggestions" },
      confirm: { type: "boolean", description: "The owner explicitly asked for this bulk accept" },
    },
  },
  async run(c, a) {
    const ids = (Array.isArray(a.proposal_ids) ? a.proposal_ids : []).map(str).filter(Boolean);
    const sourceQ = str(a.source);
    if (!ids.length && !sourceQ) return { ok: false, clarify: true, line: "Which suggestions: give me their ids, or the source whose high-confidence suggestions I should accept." };
    let list: Json[] = [];
    let refused = 0, skippedFlagged = 0;
    let scope = "";

    if (ids.length) {
      const valid = ids.filter((i) => UUID_RE.test(i));
      const { data } = valid.length ? await c.db.from("caio_proposals").select("id, org_id, status, summary, kind, flags").in("id", valid) : { data: [] };
      const found = (data ?? []) as Json[];
      list = found.filter((p) => p.org_id === c.orgId);
      refused = found.length - list.length + (ids.length - valid.length) + (valid.length - found.length);
      if (!list.length) return { ok: false, line: `None of those ids are suggestions in your organization, so I accepted nothing.` };
      scope = plural(list.length, "named suggestion");
    } else {
      let src: Json | null = null;
      if (UUID_RE.test(sourceQ)) {
        const { data } = await c.db.from("caio_sources").select("id, title, org_id").eq("id", sourceQ).eq("org_id", c.orgId).maybeSingle();
        src = data as Json | null;
      } else {
        const { data } = await c.db.from("caio_sources").select("id, title, org_id").eq("org_id", c.orgId).ilike("title", `%${sourceQ.replace(/[%_]/g, "")}%`).limit(6);
        const hits = (data ?? []) as Json[];
        if (hits.length > 1) return { ok: false, clarify: true, line: `Which source: ${hits.slice(0, 5).map((h) => h.title).join("; ")}?` };
        src = hits[0] ?? null;
      }
      if (!src) return { ok: true, line: `I can't find a CAIO source matching "${sourceQ}".` };
      const { data } = await c.db.from("caio_proposals").select("id, org_id, status, summary, kind, flags, confidence").eq("source_id", src.id).eq("org_id", c.orgId).eq("status", "proposed").eq("confidence", "high");
      const all = (data ?? []) as Json[];
      list = all.filter((p) => !((p.flags ?? []) as string[]).some((f) => BULK_EXCLUDED_FLAGS.includes(f)));
      skippedFlagged = all.length - list.length;
      if (!list.length) return { ok: true, line: `"${src.title}" has no high-confidence suggestions I can accept in bulk${skippedFlagged ? ` (${plural(skippedFlagged, "flagged one")} need you to review them by id)` : ""}.` };
      scope = `${plural(list.length, "high-confidence suggestion")} from "${src.title}"`;
      if (a.confirm !== true) {
        const facts = list.filter((p) => p.kind === "fact").length;
        return { ok: true, clarify: true, line: `Accept ${scope} (${plural(facts, "fact")}, ${plural(list.length - facts, "record")})${skippedFlagged ? `; ${plural(skippedFlagged, "flagged one")} stay for your review` : ""}? Say yes and I'll write them.` };
      }
    }

    const written: Json[] = [], failed: string[] = [];
    let already = 0;
    for (const p of list) {
      if (p.status !== "proposed") { already++; continue; }
      const { data, error } = await c.db.rpc("caio_accept_proposal", { p_id: p.id, p_edit: null });
      const r = data as Json | null;
      if (error) failed.push(`${String(p.summary ?? p.id).slice(0, 70)}: ${String(error.message).replace(/^caio_\w+:\s*/, "").slice(0, 110)}`);
      else if (r && r.ok === false) already++;
      else written.push(p);
    }
    const facts = written.filter((p) => p.kind === "fact").length;
    const bits = [
      written.length ? `Accepted ${plural(written.length, "suggestion")} (${plural(facts, "confirmed fact")}, ${plural(written.length - facts, "register record")}).` : "Nothing was written.",
      failed.length ? `${plural(failed.length, "suggestion")} failed validation and ${failed.length === 1 ? "was" : "were"} left open: ${failed.slice(0, 3).join("; ")}.` : "",
      already ? `${plural(already, "suggestion")} had already been decided.` : "",
      refused ? `${plural(refused, "id")} ${refused === 1 ? "was" : "were"} not ${refused === 1 ? "a suggestion" : "suggestions"} in your organization and ${refused === 1 ? "was" : "were"} ignored.` : "",
      skippedFlagged ? `${plural(skippedFlagged, "flagged suggestion")} left for your review.` : "",
    ].filter(Boolean);
    return { ok: written.length > 0 || failed.length === 0, line: bits.join(" "), detail: asDetail({ scope, written: written.map((p) => p.id), failed }, true) };
  },
};

export const caioNeedsInputTool: OwnerTool = {
  name: "caio_needs_input",
  readOnly: true, ownerOnly: true,
  description: "The open 'needs your input' items for CAIO engagements (facts or register entries the documents cannot be drafted without), ranked by how many documents each one blocks. Give client (name or engagement code) for one; omit for all. Use for 'what do you need from me for Acme', 'what's blocking the day-30 documents'.",
  input_schema: { type: "object", properties: { client: { type: "string" } } },
  async run(c, a) {
    const client = str(a.client);
    const engs = await engagementsFor(c, client);
    if (!engs.length) return { ok: true, line: client ? `I don't see a CAIO engagement matching "${client}".` : "There are no active CAIO engagements yet." };
    const { data } = await c.db.from("caio_input_requests").select("engagement_id, kind, key, label, why, blocks_templates").in("engagement_id", engs.map((e) => e.id)).eq("status", "open").limit(500);
    const name = new Map(engs.map((e) => [e.id, e.client_legal_name as string]));
    const items = ((data ?? []) as Json[]).map((r) => ({ client: name.get(r.engagement_id) ?? "", kind: r.kind, key: r.key, label: r.label, why: r.why, blocks: ((r.blocks_templates ?? []) as number[]).length }))
      .sort((x, y) => y.blocks - x.blocks || x.label.localeCompare(y.label));
    if (!items.length) return { ok: true, line: "Nothing is waiting on you for the CAIO documents." };
    const top = items.slice(0, 3).map((i) => `${i.label} (blocks ${plural(i.blocks, "document")})`).join("; ");
    return { ok: true, line: `${plural(items.length, "item")} need your input. Biggest blockers: ${top}.`, detail: asDetail(items, true) };
  },
};

export const CAIO_TOOLS: OwnerTool[] = [caioStatusTool, caioInboxTool, caioAcceptTool, caioNeedsInputTool];
