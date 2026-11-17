import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { OWNER_TOOLS, type OwnerCtx, runTool } from "./owner-tools.ts";

const tool = (n: string) => OWNER_TOOLS.find((t) => t.name === n)!;
const P = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const OTHER = "00000000-0000-4000-8000-0000000000ff";

function setup() {
  const accepted: string[] = [];
  const f = new FakeSupabase({
    caio_engagements: [{ id: "e1", org_id: "o", engagement_code: "C-1", client_legal_name: "Acme Roofing", status: "active" }],
    caio_sources: [{ id: "s1", org_id: "o", engagement_id: "e1", title: "Ops interview", process_status: "ready" }, { id: "s2", org_id: "o", engagement_id: "e1", title: "HR interview", process_status: "needs_review" }],
    caio_proposals: [
      { id: P(1), org_id: "o", engagement_id: "e1", source_id: "s1", status: "proposed", kind: "fact", confidence: "high", flags: [], summary: "42 staff" },
      { id: P(2), org_id: "o", engagement_id: "e1", source_id: "s1", status: "proposed", kind: "record", confidence: "high", flags: [], summary: "Helpy" },
      { id: P(3), org_id: "o", engagement_id: "e1", source_id: "s1", status: "proposed", kind: "record", confidence: "high", flags: ["legal_candidate"], summary: "Zed logging" },
      { id: P(4), org_id: "o", engagement_id: "e1", source_id: "s1", status: "proposed", kind: "record", confidence: "low", flags: [], summary: "Maybe a tool" },
      { id: OTHER, org_id: "other", engagement_id: "ex", source_id: "sx", status: "proposed", kind: "fact", confidence: "high", flags: [], summary: "Foreign" },
    ],
    caio_facts: [{ engagement_id: "e1", fact_key: "industry", status: "proposed" }],
    caio_meeting_links: [{ org_id: "o", meeting_transcription_id: "m1", state: "needs_link" }],
    caio_input_requests: [
      { engagement_id: "e1", kind: "fact", key: "staff_count", label: "Number of staff", why: "", blocks_templates: [2], status: "open" },
      { engagement_id: "e1", kind: "register", key: "vendors", label: "Vendors", why: "", blocks_templates: [5, 6, 7], status: "open" },
      { engagement_id: "e1", kind: "fact", key: "done", label: "Resolved", why: "", blocks_templates: [1, 2, 3, 4], status: "resolved" },
    ],
  }, {
    rpc: {
      caio_accept_proposal: (a) => {
        const id = a.p_id as string;
        if (id === P(2)) throw new Error("x");
        accepted.push(id);
        return { ok: true, status: "accepted" };
      },
    },
  });
  // make the stub report a validation failure through the rpc error channel for P(2)
  const rpc = f.rpc.bind(f);
  f.rpc = (name: string, args: Record<string, unknown> = {}) => {
    if (name === "caio_accept_proposal" && args.p_id === P(2)) return Promise.resolve({ data: null, error: { message: "caio_records: secret-like content in Purpose: link to where it is stored instead" } }) as never;
    return rpc(name, args) as never;
  };
  const c: OwnerCtx = {
    db: asClient(f), env: { get: () => undefined }, orgId: "o", ownerUserId: "owner", claraUserId: "clara", claraNumber: "+1", channel: "chat", ownerVerified: true,
    now: () => new Date("2026-11-06T12:00:00Z"), sendSms: () => Promise.resolve(true), sendEmail: () => Promise.resolve(), createEvent: () => Promise.resolve({ id: "e" }),
  };
  return { f, c, accepted };
}

Deno.test("caio tools: flags match the registry (status/inbox/needs_input read-only, accept writes), all owner-only", () => {
  for (const n of ["caio_status", "caio_inbox", "caio_needs_input"]) assertEquals([tool(n).readOnly, tool(n).ownerOnly], [true, true]);
  assertEquals([tool("caio_accept").readOnly ?? false, tool("caio_accept").ownerOnly], [false, true]);
});

Deno.test("owner gate: an unverified turn cannot run caio_accept", async () => {
  const { c, accepted } = setup();
  const r = await runTool(tool("caio_accept"), { ...c, ownerVerified: false }, { proposal_ids: [P(1)] }, "caio_accept");
  assertEquals(r.ok, false);
  assertEquals(accepted.length, 0);
});

Deno.test("caio_inbox: lines for what is waiting, per engagement and across all", async () => {
  const { c } = setup();
  const all = await tool("caio_inbox").run(c, {});
  assertEquals(all.ok, true);
  assertStringIncludes(all.line, "4 suggestions to review");
  assertStringIncludes(all.line, "1 unconfirmed fact");
  assertStringIncludes(all.line, "1 source held for review");
  assertStringIncludes(all.line, "1 meeting to link to a client");
  assertStringIncludes(all.line, "2 open input requests");
  assert(!all.line.includes("Foreign"));
  assertStringIncludes((await tool("caio_inbox").run(c, { client: "acme" })).line, "Acme Roofing:");
  assertStringIncludes((await tool("caio_inbox").run(c, { client: "nobody" })).line, "don't see");
});

Deno.test("caio_needs_input: open requests ranked by documents blocked", async () => {
  const { c } = setup();
  const r = await tool("caio_needs_input").run(c, {});
  assertStringIncludes(r.line, "2 items need your input");
  assert(r.line.indexOf("Vendors (blocks 3 documents)") < r.line.indexOf("Number of staff (blocks 1 document)"));
  assert(!r.line.includes("Resolved"));
});

Deno.test("caio_accept: refuses ids from another org and writes nothing", async () => {
  const { c, accepted } = setup();
  const r = await tool("caio_accept").run(c, { proposal_ids: [OTHER] });
  assertEquals(r.ok, false);
  assertEquals(accepted.length, 0);
});

Deno.test("caio_accept: named ids are written; foreign ids in the same call are ignored and reported", async () => {
  const { c, accepted } = setup();
  const r = await tool("caio_accept").run(c, { proposal_ids: [P(1), OTHER] });
  assertEquals(accepted, [P(1)]);
  assertStringIncludes(r.line, "Accepted 1 suggestion (1 confirmed fact, 0 register records)");
  assertStringIncludes(r.line, "1 id was not a suggestion in your organization");
});

Deno.test("caio_accept: a failed validation is reported and the proposal stays open", async () => {
  const { c, accepted } = setup();
  const r = await tool("caio_accept").run(c, { proposal_ids: [P(1), P(2)] });
  assertEquals(accepted, [P(1)]);
  assertStringIncludes(r.line, "1 suggestion failed validation and was left open: Helpy: secret-like content");
});

Deno.test("caio_accept: bulk by source asks first, then accepts only high-confidence unflagged ones on confirm", async () => {
  const { c, accepted } = setup();
  const ask = await tool("caio_accept").run(c, { source: "ops interview" });
  assertEquals([ask.ok, ask.clarify], [true, true]);
  assertStringIncludes(ask.line, "2 high-confidence suggestions");
  assertStringIncludes(ask.line, "1 flagged one stay for your review");
  assertEquals(accepted.length, 0);
  const done = await tool("caio_accept").run(c, { source: "ops interview", confirm: true });
  assertEquals(accepted, [P(1)]); // P(2) fails validation in this stub, P(3) flagged, P(4) low confidence
  assertStringIncludes(done.line, "1 flagged suggestion left for your review");
});

Deno.test("caio_accept: needs something to accept", async () => {
  const { c } = setup();
  assertEquals((await tool("caio_accept").run(c, {})).clarify, true);
});
