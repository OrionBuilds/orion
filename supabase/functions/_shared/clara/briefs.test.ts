import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { briefDue, gatherBriefData, modelBrief, runBrief, templateBrief } from "./briefs.ts";

const ENV = { get: (k: string) => ({ CLARA_USER_ID: "clara", CLARA_CALENDAR_USER_ID: "cal", OWNER_USER_ID: "owner", OWNER_NAME: "Jordan Example", OWNER_FIRST_NAME: "Jordan", CLARA_TZ: "America/New_York" })[k] };
const NOW = new Date("2026-10-23T12:00:00Z"); // Fri 08:00 ET

Deno.test("briefs are due at 08:00 and 20:00 local, and Friday 16:00 adds the weekly review", () => {
  assertEquals(briefDue(NOW, "America/New_York"), { kind: "morning", localDate: "2026-10-23" });
  assertEquals(briefDue(new Date("2026-10-24T00:00:00Z"), "America/New_York"), { kind: "evening", localDate: "2026-10-23" });
  assertEquals(briefDue(new Date("2026-10-23T20:00:00Z"), "America/New_York"), { kind: "weekly", localDate: "2026-10-23" });
  assertEquals(briefDue(new Date("2026-10-22T20:00:00Z"), "America/New_York"), null); // Thursday 16:00: nothing
  assertEquals(briefDue(new Date("2026-10-23T15:00:00Z"), "America/New_York"), null);
});

function seeded() {
  return new FakeSupabase({
    microsoft_calendar_events: [{ user_id: "cal", title: "Standup", start_time: "2026-10-23T14:00:00Z", end_time: "2026-10-23T14:30:00Z", status: "confirmed" }],
    workflow_approval_queue: [{ id: "a1", org_id: "o", status: "pending_approval", source: "agent_approval", title: "Check-in to Pat Lee", agent_slug: "clara", requested_at: "2026-10-23T01:00:00Z" }],
    clara_notifications: [
      { id: "n1", organization_id: "o", kind: "run.done", text: "FRIDAY finished the Acme fix", delivered_at: null, created_at: "2026-10-23T02:00:00Z" },
      { id: "n2", organization_id: "o", kind: "old", text: "already delivered", delivered_at: "2026-10-22T10:00:00Z", created_at: "2026-10-22T09:00:00Z" },
    ],
    agent_requests: [
      { org_id: "o", from_user_id: "clara", title: "Fix checkout", status: "claimed", updated_at: "2026-10-23T05:00:00Z" },
      { org_id: "o", from_user_id: "clara", title: "Add footer links", status: "completed", result_summary: "PR #7 merged", updated_at: "2026-10-23T06:00:00Z" },
    ],
    messages: [
      { organization_id: "o", direction: "inbound", channel: "email", contact_id: "c1", sent_at: "2026-10-23T03:00:00Z" },
      { organization_id: "o", direction: "inbound", channel: "sms", contact_id: "c1", sent_at: "2026-10-23T04:00:00Z" },
    ],
    contacts: [{ id: "c1", first_name: "Pat", last_name: "Lee", company: "Acme" }],
    call_logs: [{ organization_id: "o", direction: "inbound", status: "no-answer", created_at: "2026-10-23T03:30:00Z", duration: 0 }, { organization_id: "o", direction: "inbound", status: "completed", created_at: "2026-10-23T04:30:00Z", duration: 90 }],
    appointments: [{ org_id: "o", status: "scheduled", start_at_utc: "2026-10-23T18:00:00Z", contact_id: "c1" }],
    calendar_tasks: [{ org_id: "o", user_id: "owner", title: "Review Acme proposal", status: "pending", due_at_utc: "2026-10-23T21:00:00Z" }],
    contact_timeline: [{ event_type: "feedback", event_data: { score: 2, text: "checkout still broken" }, created_at: "2026-10-23T05:00:00Z" }],
    clara_briefs: [],
  }, { unique: { clara_briefs: [["organization_id", "kind", "local_date"]] } });
}

Deno.test("gathering pulls each section from OS data, and a broken section never kills the brief", async () => {
  const f = seeded();
  const d = await gatherBriefData(asClient(f), ENV, "o", "morning", NOW);
  assertEquals(d.agenda.map((e) => e.title), ["Standup"]);
  assertEquals(d.approvals.map((a) => a.title), ["Check-in to Pat Lee"]);
  assertEquals(d.held.map((h) => h.id), ["n1"]);                       // only undelivered items
  assertEquals(d.fridayOpen, ["Fix checkout"]);
  assertEquals(d.fridayDone[0].startsWith("Add footer links — completed: PR #7"), true);
  assertEquals([d.inbound.email, d.inbound.sms, d.inbound.people], [1, 1, ["Pat Lee"]]);
  assertEquals(d.missedOrUnhandledCalls, 1);
  assertEquals(d.appointments[0].who, "Pat Lee");
  assertEquals(d.ownerTasks[0].title, "Review Acme proposal");
  assertEquals(d.lowFeedback, ["2/5: checkout still broken"]);

  const broken = asClient(f);
  const origFrom = broken.from.bind(broken);
  broken.from = (t: string) => { if (t === "agent_requests") throw new Error("table down"); return origFrom(t); };
  const d2 = await gatherBriefData(broken, ENV, "o", "morning", NOW);
  assertEquals([d2.fridayOpen.length, d2.approvals.length], [0, 1]);
});

Deno.test("the template brief leads with decisions and is complete without a model", async () => {
  const d = await gatherBriefData(asClient(seeded()), ENV, "o", "morning", NOW);
  const b = templateBrief(ENV, d);
  assertEquals(b.body.indexOf("Needs your decision") < b.body.indexOf("Today"), true);
  for (const s of ["Check-in to Pat Lee", "Standup", "Review Acme proposal", "Fix checkout", "calls that were not answered"]) assertStringIncludes(b.body, s);
  const empty = templateBrief(ENV, { ...d, approvals: [], agenda: [], appointments: [], ownerTasks: [], fridayOpen: [], fridayDone: [], inbound: { email: 0, sms: 0, voice: 0, people: [] }, missedOrUnhandledCalls: 0, held: [], lowFeedback: [] });
  assertStringIncludes(empty.body, "Nothing needs you right now");
});

Deno.test("a brief is sent once per day, carries the held notifications, then marks exactly those delivered", async () => {
  const f = seeded(); const sent: string[] = [];
  const run = () => runBrief(asClient(f), ENV, { orgId: "o", now: NOW, due: { kind: "morning", localDate: "2026-10-23" }, send: (s, b) => { sent.push(s + "|" + b); return Promise.resolve(); }, model: () => Promise.resolve(null) });
  assertEquals(await run(), "sent");
  assertEquals(await run(), "already");
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0], "FRIDAY finished the Acme fix");
  assertEquals(f.rows("clara_notifications").find((n) => n.id === "n1")!.delivered_via, "digest");
  assertEquals(f.rows("clara_briefs")[0].composed_by, "template");
});

Deno.test("the model's wording is used when available; a failed send leaves held items un-delivered and retryable", async () => {
  const f = seeded(); const sent: string[] = [];
  const ok = await runBrief(asClient(f), ENV, { orgId: "o", now: NOW, due: { kind: "evening", localDate: "2026-10-23" }, send: (s) => { sent.push(s); return Promise.resolve(); }, model: () => Promise.resolve({ subject: "Evening, Jordan", body: "A".repeat(60) }) });
  assertEquals([ok, sent[0], f.rows("clara_briefs")[0].composed_by], ["sent", "Evening, Jordan", "model"]);

  const g = seeded();
  const bad = await runBrief(asClient(g), ENV, { orgId: "o", now: NOW, due: { kind: "morning", localDate: "2026-10-23" }, send: () => Promise.reject(new Error("graph 503")), model: () => Promise.resolve(null) });
  assertEquals(bad, "failed");
  assertEquals(g.rows("clara_notifications").find((n) => n.id === "n1")!.delivered_at, null); // still held
  assertEquals(g.rows("clara_briefs")[0].delivered_at, undefined);
  const retry = await runBrief(asClient(g), ENV, { orgId: "o", now: NOW, due: { kind: "morning", localDate: "2026-10-23" }, send: () => Promise.resolve(), model: () => Promise.resolve(null) });
  assertEquals(retry, "sent");
  assertEquals(g.rows("clara_briefs").length, 1); // reused the stored row, no duplicate
});

Deno.test("modelBrief sends a request Anthropic accepts: structured output is {type, schema} only (no OpenAI-style name), key in x-api-key", async () => {
  let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  const f = ((url: string, init: RequestInit) => {
    sent = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ subject: "Morning brief", body: "x".repeat(60) }) }] }), { status: 200 }));
  }) as typeof fetch;
  const env = { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "test-key" : ENV.get(k)) };
  const out = await modelBrief(env, { kind: "morning" } as never, f);
  assertEquals(out?.subject, "Morning brief");
  const format = (sent!.body.output_config as { format: Record<string, unknown> }).format;
  assertEquals(Object.keys(format).sort(), ["schema", "type"]);
  assertEquals(sent!.headers["x-api-key"], "test-key");
});

Deno.test("modelBrief returns null (template fallback) on an API error instead of throwing", async () => {
  const f = (() => Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }))) as typeof fetch;
  const env = { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "test-key" : ENV.get(k)) };
  assertEquals(await modelBrief(env, { kind: "morning" } as never, f), null);
});
