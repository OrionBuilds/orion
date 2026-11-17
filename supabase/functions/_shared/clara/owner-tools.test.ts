import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { OWNER_TOOLS, type OwnerCtx, resolveRecipient, searchContacts } from "./owner-tools.ts";

const tool = (n: string) => OWNER_TOOLS.find((t) => t.name === n)!;
const NOW = new Date("2026-10-20T15:00:00Z");

function setup(seed: Record<string, Record<string, unknown>[]> = {}, over: Partial<OwnerCtx> = {}, envMap: Record<string, string> = {}) {
  const f = new FakeSupabase({
    contacts: [
      { id: "c1", organization_id: "o", status: "active", first_name: "Casey", last_name: "Lee", email: "casey@acme.com", phone: "+15551230001", company: "Acme" },
      { id: "c2", organization_id: "o", status: "active", first_name: "Jackie", last_name: "Brown", email: null, phone: "+15551230002", company: "Brown Co" },
      { id: "c3", organization_id: "o", status: "active", first_name: "Sam", last_name: "Park", email: "sam@x.com", phone: "+15551230003", company: "X" },
      { id: "c4", organization_id: "o", status: "active", first_name: "Sam", last_name: "Ortiz", email: "samo@y.com", phone: null, company: "Y" },
      { id: "c5", organization_id: "o", status: "active", first_name: "Jacklyn", last_name: "Reed", email: null, phone: "+15551230005", company: "Reed Co" },
    ],
    users: [{ id: "friday-id", organization_id: "o", email: "friday@example.com" }],
    calendars: [{ id: "cal1", org_id: "o", type: "user", owner_user_id: "owner" }],
    ...seed,
  }, { rpc: { find_contact_id_by_phone: (a) => (a.p_phone === "+15551230001" ? "c1" : null) } });
  const log: string[] = [];
  const c: OwnerCtx = {
    db: asClient(f), env: { get: (k: string) => envMap[k] }, orgId: "o", ownerUserId: "owner", claraUserId: "clara", claraNumber: "+18135550142",
    channel: "sms", ownerVerified: true, now: () => NOW,
    sendSms: (from, to, body) => { log.push(`sms:${from}>${to}:${body}`); return Promise.resolve(true); },
    sendEmail: (m) => { log.push(`email:${m.to.join(",")}:${m.subject}`); return Promise.resolve(); },
    createEvent: (e) => { log.push(`event:${e.subject}:${e.startISO}:${e.attendees.join(",")}`); return Promise.resolve({ id: "ev1" }); },
    ...over,
  };
  return { f, c, log };
}

Deno.test("name resolution: unique match resolves, ambiguous asks, missing channel asks", async () => {
  const { c } = setup();
  assertEquals((await resolveRecipient(c, "Casey", "email")).address, "casey@acme.com");
  assertEquals((await resolveRecipient(c, "Casey Lee", "phone")).address, "+15551230001");
  const amb = await resolveRecipient(c, "Sam", "email");
  assertEquals(amb.clarify?.startsWith("Which Sam do you mean"), true);
  assertEquals((await resolveRecipient(c, "Jackie", "email")).clarify?.includes("no email address on file"), true);
  assertEquals((await resolveRecipient(c, "Nobody Here", "phone")).clarify?.includes("don't have a contact"), true);
  assertEquals((await resolveRecipient(c, "ann@z.com", "email")).address, "ann@z.com");
  assertEquals((await searchContacts(c.db, "o", "acme")).map((p) => p.name), ["Casey Lee"]);
});

Deno.test("send_email sends via the mailbox and says so; failure says nothing was sent", async () => {
  const ok = setup();
  const r = await tool("send_email").run(ok.c, { to: ["Casey"], subject: "Tomorrow", body: "See you at 10. — Clara" });
  assertEquals([r.ok, r.line], [true, 'Emailed casey@acme.com — "Tomorrow". You\'re CC\'d.']);
  assertEquals(ok.log, ["email:casey@acme.com:Tomorrow"]);
  const bad = setup({}, { sendEmail: () => Promise.reject(new Error("token expired")) });
  const f = await tool("send_email").run(bad.c, { to: ["Casey"], subject: "x", body: "y" });
  assertEquals([f.ok, f.line.includes("Nothing was sent")], [false, true]);
  const amb = await tool("send_email").run(ok.c, { to: ["Sam"], subject: "x", body: "y" });
  assertEquals([amb.ok, amb.clarify], [false, true]);
});

Deno.test("send_text sends from Clara's number, logs the thread, and refuses opted-out numbers", async () => {
  const s = setup();
  const r = await tool("send_text").run(s.c, { to: "Casey", body: "Running 10 min late. — Clara" });
  assertEquals(r, { ok: true, line: "Texted Casey Lee." });
  assertEquals(s.log, ["sms:+18135550142>+15551230001:Running 10 min late. — Clara"]);
  assertEquals(s.f.rows("messages")[0].sender_name, "Clara");
  assertEquals(s.f.rows("messages")[0].direction, "outbound");
  const dnc = setup({ dnc_numbers: [{ org_id: "o", phone_number: "+15551230001" }] });
  const blocked = await tool("send_text").run(dnc.c, { to: "Casey", body: "hi" });
  assertEquals([blocked.ok, blocked.line.includes("opted out"), dnc.log.length], [false, true, 0]);
  const fail = setup({}, { sendSms: () => Promise.resolve(false) });
  assertEquals((await tool("send_text").run(fail.c, { to: "+15551230001", body: "x" })).line.includes("Nothing was sent"), true);
});

Deno.test("delegate_to_friday queues a real request for FRIDAY and promises only 'queued'", async () => {
  const s = setup();
  const r = await tool("delegate_to_friday").run(s.c, { kind: "bug", title: "Login 500s", details: "Repro: POST /login with empty body. Expect 400." });
  assertEquals(r.ok, true);
  assertEquals(r.line.startsWith('Queued for FRIDAY (bug): "Login 500s"'), true);
  const row = s.f.rows("agent_requests")[0];
  assertEquals([row.from_user_id, row.to_user_id, row.kind, (row.source as { requested_by: string }).requested_by], ["clara", "friday-id", "bug", "owner"]);
  const none = setup({ users: [] });
  assertEquals((await tool("delegate_to_friday").run(none.c, { kind: "code", title: "t", details: "d" })).ok, false);
});

Deno.test("create_task: personal list on the owner's calendar; creates that calendar when missing", async () => {
  const s = setup();
  const r = await tool("create_task").run(s.c, { title: "Review Acme proposal", due: "2026-10-22T17:00:00-04:00", priority: "high" });
  assertEquals(r.ok, true);
  const row = s.f.rows("calendar_tasks")[0];
  assertEquals([row.user_id, row.calendar_id, row.due_at_utc, row.priority, row.status, row.org_id], ["owner", "cal1", "2026-10-22T21:00:00.000Z", "high", "pending", "o"]);
  // The live bug: no type='user' calendar for the owner. Now the first task sets one up (as the calendar module would).
  const noCal = setup({ calendars: [] });
  const made = await tool("create_task").run(noCal.c, { title: "Call the bank" });
  assertEquals(made.ok, true);
  const cal = noCal.f.rows("calendars")[0];
  assertEquals([cal.org_id, cal.type, cal.owner_user_id, cal.active, cal.slug], ["o", "user", "owner", true, "personal-owner"]);
  assertEquals(noCal.f.rows("calendar_tasks")[0].calendar_id, cal.id);
  // A second task reuses it.
  await tool("create_task").run(noCal.c, { title: "Second" });
  assertEquals(noCal.f.rows("calendars").length, 1);
  // Another org's calendar is never used.
  const other = setup({ calendars: [{ id: "x", org_id: "other", type: "user", owner_user_id: "owner", active: true }] });
  await tool("create_task").run(other.c, { title: "t" });
  assertEquals(other.f.rows("calendar_tasks")[0].calendar_id === "x", false);
  assertEquals((await tool("create_task").run(setup({}, { ownerUserId: null }).c, { title: "x" })).ok, false);
});

Deno.test("create_task: under a project (resolved by name, org-scoped) or on a contact, assigned to the owner", async () => {
  const finds: Record<string, unknown>[] = [];
  const s = setup({ projects: [{ id: "11111111-1111-1111-1111-111111111111", org_id: "o", name: "Umbrella Roofing Site", contact_id: "c1" }] });
  (s.f.opts.rpc ??= {}).clara_find = (a) => { finds.push(a); return [{ type: "project", id: "11111111-1111-1111-1111-111111111111", title: "Umbrella Roofing Site", score: 1.6 }]; };
  const r = await tool("create_task").run(s.c, { title: "Fix the hero image", project: "the Umbrella Roofing site project", due: "2026-10-23", priority: "low" });
  assertEquals(r.ok, true);
  assertEquals(finds[0].p_org, "o");
  const t = s.f.rows("project_tasks")[0];
  assertEquals([t.org_id, t.project_id, t.assigned_user_id, t.status, t.due_date, t.priority], ["o", "11111111-1111-1111-1111-111111111111", "owner", "todo", "2026-10-23", "low"]);
  // Two strong project matches -> one question, nothing written.
  const two = setup();
  (two.f.opts.rpc ??= {}).clara_find = () => [{ type: "project", id: "a", title: "Umbrella Roofing Site", score: 1.5 }, { type: "project", id: "b", title: "Umbrella Roofing SEO", score: 1.5 }];
  const amb = await tool("create_task").run(two.c, { title: "x", project: "umbrella roofing" });
  assertEquals([amb.ok, amb.clarify, two.f.rows("project_tasks").length], [false, true, 0]);
  // Contact task.
  const c = setup();
  const ct = await tool("create_task").run(c.c, { title: "Send Casey the deck", contact: "Casey" });
  assertEquals(ct.ok, true);
  const row = c.f.rows("contact_tasks")[0];
  assertEquals([row.contact_id, row.assigned_to_user_id, row.status], ["c1", "owner", "pending"]);
  assertEquals((await tool("create_task").run(c.c, { title: "x", contact: "Sam" })).clarify, true);
});
Deno.test("create_event rejects past times, clarifies without a time, and invites only valid emails", async () => {
  const s = setup();
  assertEquals((await tool("create_event").run(s.c, { subject: "x", start: "2026-10-19T10:00:00-04:00" })).clarify, true);
  assertEquals((await tool("create_event").run(s.c, { subject: "x", start: "tomorrow-ish" })).clarify, true);
  const r = await tool("create_event").run(s.c, { subject: "Kickoff", start: "2026-10-22T10:00:00-04:00", attendees: ["a@b.co", "not-an-email"] });
  assertEquals(r.ok, true);
  assertEquals(s.log, ["event:Kickoff:2026-10-22T14:00:00.000Z:a@b.co"]);
});

Deno.test("find_contact reports what's there and never invents", async () => {
  const s = setup();
  assertEquals((await tool("find_contact").run(s.c, { query: "zzz" })).line, 'No contact matching "zzz".');
  assertEquals((await tool("find_contact").run(s.c, { query: "Casey" })).line, "Casey Lee, Acme.");
});
Deno.test("answer_friday answers FRIDAY with a NEW request (in_reply_to) and closes the old one, whoever sent it; refuses when none or ambiguous", async () => {
  // FRIDAY asked on a request the owner sent from the thread (not from Clara): still answerable.
  const waiting = (id: string, title: string, from = "jordan") => ({
    id, org_id: "o", from_user_id: from, to_user_id: "friday-id", kind: "code", status: "needs_input", title, body: "orig",
    result_summary: "Which env?", finished_at: "2026-10-20T14:00:00Z", source: { channel: "agent_thread", channel_id: "ch" }, payload: {},
  });
  const s = setup({ agent_requests: [waiting("r1", "Login 500")], agent_thread_turns: [{ message_id: "m0", agent_request_id: "r1", status: "needs_input" }] });
  const r = await tool("answer_friday").run(s.c, { message: "staging" });
  assertEquals(r.ok, true);
  const old = s.f.rows("agent_requests").find((x) => x.id === "r1")!;
  const fresh = s.f.rows("agent_requests").find((x) => x.id !== "r1")!;
  assertEquals([old.status, (old.result as Record<string, unknown>).superseded_by, old.notified_at !== null], ["cancelled", fresh.id, true]);
  assertEquals([fresh.title, fresh.to_user_id, fresh.from_user_id, fresh.kind], ["Re: Login 500", "friday-id", "jordan", "code"]);
  assertEquals((fresh.payload as Record<string, unknown>).in_reply_to, "r1");
  assertEquals((fresh.source as Record<string, unknown>).requested_by, "owner");
  assertEquals(String(fresh.body).includes("Which env?") && String(fresh.body).includes("staging") && String(fresh.body).includes("orig"), true);
  // The thread turn now follows the new request, so FRIDAY's reply lands in the thread.
  assertEquals([s.f.rows("agent_thread_turns")[0].agent_request_id, s.f.rows("agent_thread_turns")[0].status], [fresh.id, "queued"]);
  // Answering again finds nothing waiting (the old row is closed, never re-queued).
  assertEquals((await tool("answer_friday").run(s.c, { message: "prod" })).line, "FRIDAY isn't waiting on an answer from you right now.");
  assertEquals((await tool("answer_friday").run(setup().c, { message: "x" })).line, "FRIDAY isn't waiting on an answer from you right now.");
  // Requests to someone else are not FRIDAY's questions.
  const other = setup({ agent_requests: [{ ...waiting("r9", "Ad copy"), to_user_id: "other-agent-id" }] });
  assertEquals((await tool("answer_friday").run(other.c, { message: "x" })).ok, false);
  const two = setup({ agent_requests: [waiting("r1", "Login 500", "clara"), waiting("r2", "Search slow")] });
  assertEquals((await tool("answer_friday").run(two.c, { message: "x" })).clarify, true);
  assertEquals((await tool("answer_friday").run(two.c, { message: "x", title_contains: "search" })).ok, true);
});
Deno.test("owner gate: owner-only tools refuse an unverified turn; write tools still go through runTool", async () => {
  const { runTool, NOT_OWNER_LINE } = await import("./owner-tools.ts");
  const s = setup({}, { ownerVerified: false });
  for (const name of ["find_contact", "list_approvals", "find", "client_overview", "money_status", "mailbox_status", "meetings", "conversation_history", "recent_messages", "agents_status", "project_work", "calendar_agenda", "search_records", "my_tasks", "recall", "remember"]) {
    assertEquals(OWNER_TOOLS.find((t) => t.name === name)?.ownerOnly, true, name);
    assertEquals((await runTool(tool(name), s.c, { query: "x", who: "x", kind: "calls", fact: "x" })).line, NOT_OWNER_LINE, name);
  }
  // Every read-only tool is owner-only.
  assertEquals(OWNER_TOOLS.filter((t) => t.readOnly && !t.ownerOnly).map((t) => t.name), []);
  assertEquals((await runTool(undefined, s.c, {}, "nope")).line, "I don't have a tool called nope.");
  const boom = { name: "boom", description: "", input_schema: {}, run: () => Promise.reject(new Error("kaput")) };
  assertEquals((await runTool(boom, s.c, {})).line.includes("Nothing was changed"), true);
});
Deno.test("call_person queues an owner-requested call (not places it) and says exactly that", async () => {
  const s = setup();
  const r = await tool("call_person").run(s.c, { who: "Casey", goal: "I'm calling to confirm tomorrow's 10am.", must_confirm: ["Still on?"] });
  assertEquals(r.ok, true);
  assertEquals(r.line.startsWith("Call to Casey Lee queued; it goes out within a couple of minutes"), true);
  const row = s.f.rows("clara_call_requests")[0];
  assertEquals([row.requested_by, row.kind, row.phone_e164, row.contact_id, row.status === undefined || row.status === "queued"], ["owner", "owner_request", "+15551230001", "c1", true]);
  // A business that isn't in the CRM: number + a name.
  const biz = await tool("call_person").run(s.c, { who: "+1 (813) 555-0100", business_name: "Luigi's", goal: "Book a table for four on Friday at 7pm.", not_before: "2026-10-22T10:00:00-04:00" });
  assertEquals(biz.line.startsWith("Call to Luigi's queued for"), true);
  assertEquals(s.f.rows("clara_call_requests")[1].phone_e164, "+18135550100");
  // Ambiguous name (Jacklyn and Jackie both have numbers) -> asks, queues nothing.
  const amb = await tool("call_person").run(s.c, { who: "Jack", goal: "x y z" });
  assertEquals([amb.ok, amb.clarify, s.f.rows("clara_call_requests").length], [false, true, 2]);
});

Deno.test("approvals: list shows what's waiting; deciding needs one clear match and goes through the audited RPC", async () => {
  const decisions: unknown[] = [];
  const f = new FakeSupabase({ workflow_approval_queue: [
    { id: "a1", org_id: "o", status: "pending_approval", source: "agent_approval", title: "Check-in to Pat Lee", description: "stalled", agent_slug: "clara", requested_at: "2026-10-20T01:00:00Z" },
    { id: "a2", org_id: "o", status: "pending_approval", source: "agent_run", title: "Weekly report for Acme", agent_slug: "friday", requested_at: "2026-10-20T02:00:00Z" },
  ] }, { rpc: { resolve_approval_decision: (a) => { decisions.push(a); return { status: a.p_decision === "approve" ? "approved" : "rejected" }; } } });
  const { c } = setup();
  c.db = asClient(f);
  assertEquals((await tool("list_approvals").run(c, {})).line, "2 waiting for your approval.");
  const ask = await tool("decide_approval").run(c, { decision: "approve" });
  assertEquals([ask.ok, ask.clarify], [false, true]); // two waiting, none named
  assertEquals((await tool("decide_approval").run(c, { decision: "approve", match: "nothing like this" })).clarify, true);
  const ok = await tool("decide_approval").run(c, { decision: "approve", match: "pat" });
  assertEquals([ok.ok, ok.line.startsWith('Approved: "Check-in to Pat Lee"')], [true, true]);
  assertEquals(decisions.length, 1);
  assertEquals((decisions[0] as { p_approval_id: string; p_user_id: string }).p_approval_id, "a1");
  assertEquals((await tool("decide_approval").run(c, { decision: "reject", match: "2" })).line.startsWith('Rejected: "Weekly report for Acme"'), true);
  assertEquals((await tool("decide_approval").run(c, { decision: "maybe" })).clarify, true);
});
