import { assertEquals, assert } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import {
  anthropicModel, classifyClarity, classifyScope, clarifyRoundOutcome, clarifySilenceAction, crHopsToApproved, draftClarifyQuestion, firstClientReply,
  markerStale, nextAckAttempt, raiseApproval, startBudget, ticketKind, ticketName, HOUR,
} from "./portal.ts";

const env = { get: (k: string) => ({ BUSINESS_NAME: "Acme Co", ANTHROPIC_API_KEY: "k" })[k] };

Deno.test("ticket naming and kind mapping", () => {
  assertEquals(ticketName({ title: "  Fix login ", subject: "" }), "Fix login");
  assertEquals(ticketName({ title: "", subject: "" }), "your request");
  assertEquals([ticketKind("bug_issue"), ticketKind("feature_request"), ticketKind("configuration_change"), ticketKind("general_support"), ticketKind(null)], ["bug", "feature", "change", "other", "other"]);
});

Deno.test("clarify rounds are bounded to two", () => {
  assertEquals(clarifyRoundOutcome(1, false), "resolved");
  assertEquals(clarifyRoundOutcome(1, true), "ask_again");
  assertEquals(clarifyRoundOutcome(2, true), "force_resolve");
});

Deno.test("silence: nudge at 24h, escalate at 72h, each once", () => {
  const t0 = 1_000_000_000_000;
  assertEquals(clarifySilenceAction(t0, t0 + 23 * HOUR, null, null), "none");
  assertEquals(clarifySilenceAction(t0, t0 + 25 * HOUR, null, null), "nudge");
  assertEquals(clarifySilenceAction(t0, t0 + 25 * HOUR, t0 + 24 * HOUR, null), "none");
  assertEquals(clarifySilenceAction(t0, t0 + 73 * HOUR, t0 + 24 * HOUR, null), "escalate");
  assertEquals(clarifySilenceAction(t0, t0 + 99 * HOUR, t0 + 24 * HOUR, t0 + 72 * HOUR), "none");
});

Deno.test("the first client reply ignores internal notes, FRIDAY's own and system comments", () => {
  const thread = [
    { is_internal: true, author_name: "FRIDAY", body: "note", created_at: "2026-11-01T10:00:00Z" },
    { is_internal: false, author_name: "FRIDAY (Acme Co)", body: "question", created_at: "2026-11-01T10:01:00Z" },
    { is_internal: false, author_type: "client", author_name: "Pat", body: "the checkout page", created_at: "2026-11-01T11:00:00Z" },
    { is_internal: false, author_type: "client", author_name: "Pat", body: "also this", created_at: "2026-11-01T12:00:00Z" },
  ];
  assertEquals(firstClientReply(thread, Date.parse("2026-11-01T10:01:00Z"))?.text, "the checkout page");
  assertEquals(firstClientReply(thread, Date.parse("2026-11-01T12:00:00Z")), null);
});

Deno.test("marker staleness needs a timestamp older than 24h", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const fresh = [{ is_internal: true, body: "x [m]", created_at: "2026-11-02T01:00:00Z" }];
  const old = [{ is_internal: true, body: "x [m]", created_at: "2026-11-01T01:00:00Z" }];
  assertEquals(markerStale(fresh, "[m]", now), { parked: true, stale: false });
  assertEquals(markerStale(old, "[m]", now), { parked: true, stale: true });
  assertEquals(markerStale([], "[m]", now), { parked: false, stale: false });
});

Deno.test("ack attempts: first, then re-raise only after an expiry, at most twice", () => {
  assertEquals(nextAckAttempt([]), 1);
  assertEquals(nextAckAttempt([{ external_ref: "os-triage:ticket-ack:t:1", status: "pending_approval" }]), null);
  assertEquals(nextAckAttempt([{ external_ref: "os-triage:ticket-ack:t:1", status: "rejected" }]), null);
  assertEquals(nextAckAttempt([{ external_ref: "os-triage:ticket-ack:t:1", status: "expired" }]), 2);
  assertEquals(nextAckAttempt([{ external_ref: "os-triage:ticket-ack:t:1", status: "expired" }, { external_ref: "os-triage:ticket-ack:t:2", status: "expired" }]), null);
});

Deno.test("CR hops to approved follow the legal state machine", () => {
  assertEquals(crHopsToApproved("submitted"), ["under_review", "quoted_awaiting_approval", "approved"]);
  assertEquals(crHopsToApproved("under_review"), ["quoted_awaiting_approval", "approved"]);
  assertEquals(crHopsToApproved("approved"), []);
});

Deno.test("the time budget stops taking work", () => {
  let t = 0;
  const b = startBudget(40_000, () => t);
  assert(b.ok());
  t = 40_001;
  assert(!b.ok());
});

Deno.test("clarity: undeterminable when the model is down or gives a blank question; otherwise as judged", async () => {
  const item = { title: "Fix it", description: "broken" };
  assertEquals((await classifyClarity(() => Promise.resolve(null), item)).determinable, false);
  assertEquals((await classifyClarity(() => Promise.resolve({ needsClarify: true, clarifyQuestion: "  " }), item)).determinable, false);
  const q = await classifyClarity(() => Promise.resolve({ needsClarify: true, clarifyQuestion: "Which page?", reason: "vague" }), item);
  assertEquals([q.determinable, q.needsClarify, q.clarifyQuestion], [true, true, "Which page?"]);
  const ok = await classifyClarity(() => Promise.resolve({ needsClarify: false }), item);
  assertEquals([ok.determinable, ok.needsClarify], [true, false]);
});

Deno.test("clarity prompt carries every prior round", async () => {
  let seen = "";
  await classifyClarity((_s, p) => { seen = p; return Promise.resolve({ needsClarify: false }); }, { title: "t", description: "d" }, [{ question: "Q1?", answer: "A1" }, { question: "Q2?", answer: "A2" }]);
  assert(seen.includes("Q1?") && seen.includes("A2"));
});

Deno.test("scope: no scope on file is in scope unless strict; model outage is undeterminable", async () => {
  const cr = { title: "Add blog", description: "x" };
  assertEquals((await classifyScope(() => Promise.resolve(null), cr, null, false)).in_scope, true);
  assertEquals((await classifyScope(() => Promise.resolve(null), cr, null, true)).in_scope, false);
  assertEquals((await classifyScope(() => Promise.resolve(null), cr, "scope", false)).determinable, false);
  assertEquals((await classifyScope(() => Promise.resolve({ in_scope: false, reason: "new deliverable" }), cr, "scope", false)).in_scope, false);
});

Deno.test("the model wrapper parses JSON out of the reply and returns null on failure or no key", async () => {
  const good = anthropicModel(env, () => Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: 'Sure {"needsClarify": false}' }] }))));
  assertEquals(await good("s", "p"), { needsClarify: false });
  const bad = anthropicModel(env, () => Promise.resolve(new Response("nope", { status: 500 })));
  assertEquals(await bad("s", "p"), null);
  assertEquals(await anthropicModel({ get: () => undefined }, () => { throw new Error("must not call"); })("s", "p"), null);
});

Deno.test("the clarify question is a fixed template around the model's question", () => {
  const t = draftClarifyQuestion(env, "Pat Lee", "Checkout", "which page is broken?");
  assert(t.startsWith("Hi Pat,") && t.includes("which page is broken?") && t.endsWith("— Acme Co"));
});

Deno.test("raiseApproval is idempotent on its ref and writes a friday agent_approval row", async () => {
  const f = new FakeSupabase({ workflow_approval_queue: [] }, { unique: { workflow_approval_queue: [["agent_slug", "external_ref"]] } });
  const a = { orgId: "o", ref: "ticket-ack:t:1", actionType: "friday_ticket_reply" as const, title: "T", description: "D", action: { op: "post", kind: "ticket" as const, item_id: "t", org_id: "o", body: "hi" } };
  assertEquals((await raiseApproval(asClient(f), a)).created, true);
  assertEquals((await raiseApproval(asClient(f), a)).created, false);
  const row = f.rows("workflow_approval_queue")[0];
  assertEquals([row.agent_slug, row.source, row.status, row.external_ref], ["friday", "agent_approval", "pending_approval", "os-triage:ticket-ack:t:1"]);
});
