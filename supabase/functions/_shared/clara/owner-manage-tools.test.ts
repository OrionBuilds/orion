import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { OWNER_TOOLS, type OwnerCtx } from "./owner-tools.ts";
import { MANAGE_TOOLS } from "./owner-manage-tools.ts";
import { ownerSystemPrompt } from "./owner-brain.ts";

const tool = (n: string) => OWNER_TOOLS.find((t) => t.name === n)!;
const NOW = new Date("2026-11-12T15:00:00Z");
type Seed = Record<string, Record<string, unknown>[]>;

function setup(seed: Seed = {}, over: Partial<OwnerCtx> = {}) {
  const f = new FakeSupabase({
    contacts: [
      { id: "c1", organization_id: "o", status: "active", first_name: "Casey", last_name: "Lee", email: "casey@acme.com", phone: "+15551230001", company: "Acme" },
      { id: "c3", organization_id: "o", status: "active", first_name: "Sam", last_name: "Park", email: "sam@x.com", phone: "+15551230003", company: "X" },
      { id: "c4", organization_id: "o", status: "active", first_name: "Sam", last_name: "Ortiz", email: "samo@y.com", phone: null, company: "Y" },
      { id: "z1", organization_id: "other", status: "active", first_name: "Zed", last_name: "Other", email: "zed@other.com", phone: null, company: "Other" },
    ],
    users: [
      { id: "owner", organization_id: "o", name: "Jordan Example", email: "jordan@x.com", status: "active" },
      { id: "clara", organization_id: "o", name: "Clara Example", email: "clara@x.com", status: "active" },
      { id: "friday-id", organization_id: "o", name: "Friday Daily", email: "friday@example.com", status: "active" },
      { id: "maria", organization_id: "o", name: "Maria Diaz", email: "maria@x.com", status: "active" },
    ],
    calendars: [{ id: "cal1", org_id: "o", type: "user", owner_user_id: "owner", active: true }, { id: "cal2", org_id: "o", type: "user", owner_user_id: "maria", active: true }],
    projects: [{ id: "p1", org_id: "o", name: "Initech Box Portal", status: "active", priority: "medium", pipeline_id: "pl1" }],
    project_pipelines: [{ id: "pl1", org_id: "o", name: "Engineering" }, { id: "pl2", org_id: "o", name: "CAIO Engagements" }],
    project_stages: [{ id: "st2", pipeline_id: "pl1", name: "Kickoff", sort_order: 2 }, { id: "st1", pipeline_id: "pl1", name: "Planning", sort_order: 1 }],
    opportunities: [{ id: "d1", org_id: "o", name: "Acme retainer", status: "open", contact_id: "c1" }],
    ...seed,
  }, { rpc: { find_contact_id_by_phone: (a) => (a.p_phone === "+15551230001" ? "c1" : null) } });
  const log: string[] = [];
  const c: OwnerCtx = {
    db: asClient(f), env: { get: () => undefined }, orgId: "o", ownerUserId: "owner", claraUserId: "clara", claraNumber: "+18135550142",
    channel: "chat", ownerVerified: true, now: () => NOW,
    sendSms: () => Promise.resolve(true), sendEmail: () => Promise.resolve(), createEvent: () => Promise.resolve({ id: "ev1" }),
    changeBooking: (b) => { log.push(JSON.stringify(b)); return Promise.resolve({ ok: true }); },
    ...over,
  };
  return { f, c, log };
}

Deno.test("manage tools are registered, owner-only, and never import a cycle", () => {
  assertEquals(MANAGE_TOOLS.every((t) => t.ownerOnly === true && OWNER_TOOLS.includes(t)), true);
  assertEquals(new Set(OWNER_TOOLS.map((t) => t.name)).size, OWNER_TOOLS.length);
});

Deno.test("save_contact: adds a new person, refuses a duplicate email or number, validates input", async () => {
  const s = setup();
  const r = await tool("save_contact").run(s.c, { name: "Dana Whitfield Cole", email: "Dana@UmbrellaRoofing.example", phone: "(813) 555-0199", company: "Umbrella Roofing" });
  assertEquals([r.ok, r.line], [true, "Added Dana Whitfield Cole to the CRM (email dana@umbrellaroofing.example, phone +18135550199, company Umbrella Roofing)."]);
  const row = s.f.rows("contacts").find((x) => x.email === "dana@umbrellaroofing.example")!;
  assertEquals([row.organization_id, row.first_name, row.last_name, row.status, row.owner_id, row.created_by_user_id, row.source], ["o", "Dana", "Whitfield Cole", "active", "owner", "clara", "clara"]);

  const dupEmail = await tool("save_contact").run(s.c, { name: "J Lee", email: "CASEY@acme.com" });
  assertEquals([dupEmail.ok, dupEmail.clarify, dupEmail.line.startsWith("Casey Lee (Acme) already has casey@acme.com")], [false, true, true]);
  const dupPhone = await tool("save_contact").run(s.c, { name: "J Lee", phone: "+1 555 123 0001" });
  assertEquals([dupPhone.clarify, dupPhone.line.includes("already belongs to a contact")], [true, true]);
  assertEquals((await tool("save_contact").run(s.c, { name: "X Y", email: "not-an-email" })).clarify, true);
  assertEquals((await tool("save_contact").run(s.c, { email: "a@b.co" })).line, "What's the person's name?");
  assertEquals(s.f.rows("contacts").length, 5);
});

Deno.test("save_contact: changes one resolved contact; ambiguous names ask; other orgs are out of reach", async () => {
  const s = setup();
  const r = await tool("save_contact").run(s.c, { contact: "Casey", job_title: "COO", do_not_contact: true });
  assertEquals(r.line, "Updated Casey Lee: title COO, marked do-not-contact.");
  const row = s.f.rows("contacts").find((x) => x.id === "c1")!;
  assertEquals([row.job_title, row.dnc], ["COO", true]);
  const amb = await tool("save_contact").run(s.c, { contact: "Sam", archive: true });
  assertEquals([amb.clarify, amb.line.startsWith("Which Sam:")], [true, true]);
  assertEquals((await tool("save_contact").run(s.c, { contact: "Zed", archive: true })).line, 'I don\'t have a contact called "Zed".');
  assertEquals(s.f.rows("contacts").find((x) => x.id === "z1")!.status, "active");
  assertEquals((await tool("save_contact").run(s.c, { contact: "Casey" })).line, "What should I change on Casey Lee?");
  const arch = await tool("save_contact").run(s.c, { contact: "Sam Ortiz", archive: true });
  assertEquals([arch.line, s.f.rows("contacts").find((x) => x.id === "c4")!.status], ["Updated Sam Ortiz: archived.", "archived"]);
});

Deno.test("add_note: lands on the contact, the project or the deal", async () => {
  const s = setup();
  assertEquals((await tool("add_note").run(s.c, { about: "Casey", note: "Prefers calls after 3pm." })).line, "Note saved on Casey Lee's record.");
  assertEquals(s.f.rows("contact_notes").map((n) => [n.contact_id, n.user_id, n.content]), [["c1", "clara", "Prefers calls after 3pm."]]);
  assertEquals((await tool("add_note").run(s.c, { about: "Initech", note: "Client wants SSO in phase 2." })).line, "Note saved on Initech Box Portal.");
  assertEquals(s.f.rows("project_notes").map((n) => [n.org_id, n.project_id, n.created_by]), [["o", "p1", "clara"]]);
  assertEquals((await tool("add_note").run(s.c, { about: "Acme retainer", note: "Budget approved.", on: "deal" })).line, 'Note saved on the deal "Acme retainer".');
  assertEquals(s.f.rows("opportunity_notes").map((n) => [n.opportunity_id, n.body]), [["d1", "Budget approved."]]);
  const none = await tool("add_note").run(s.c, { about: "Nobody", note: "x" });
  assertEquals([none.ok, none.clarify], [false, true]);
});

const TASKS: Seed = {
  calendar_tasks: [
    { id: "t1", org_id: "o", calendar_id: "cal1", user_id: "owner", title: "Send Umbrella Roofing proposal", status: "pending", completed: false, due_at_utc: "2026-11-13T21:00:00Z" },
    { id: "t9", org_id: "other", calendar_id: "x", user_id: "u", title: "Send Umbrella Roofing proposal copy", status: "pending", completed: false },
  ],
  contact_tasks: [
    { id: "t2", contact_id: "c1", assigned_to_user_id: "owner", title: "Call Casey about renewal", status: "pending" },
    { id: "t8", contact_id: "z1", assigned_to_user_id: "u", title: "Call Casey about renewal (other org)", status: "pending" },
  ],
  project_tasks: [
    { id: "t3", org_id: "o", project_id: "p1", assigned_user_id: "maria", title: "Review portal QA report", status: "in_review" },
    { id: "t4", org_id: "o", project_id: "p1", assigned_user_id: "owner", title: "Review portal invoice", status: "completed", completed_at: "2026-11-01T00:00:00Z" },
  ],
};

Deno.test("update_task: complete, reopen and cancel across the three task lists, org-scoped", async () => {
  const s = setup(TASKS);
  assertEquals((await tool("update_task").run(s.c, { task: "umbrella roofing proposal", action: "complete" })).line, 'Marked "Send Umbrella Roofing proposal" done.');
  const t1 = s.f.rows("calendar_tasks").find((t) => t.id === "t1")!;
  assertEquals([t1.status, t1.completed, t1.completed_at], ["completed", true, NOW.toISOString()]);
  assertEquals(s.f.rows("calendar_tasks").find((t) => t.id === "t9")!.status, "pending");

  assertEquals((await tool("update_task").run(s.c, { task: "casey renewal", action: "cancel" })).line, 'Cancelled "Call Casey about renewal".');
  assertEquals([s.f.rows("contact_tasks").find((t) => t.id === "t2")!.status, s.f.rows("contact_tasks").find((t) => t.id === "t8")!.status], ["cancelled", "pending"]);

  assertEquals((await tool("update_task").run(s.c, { task: "portal invoice", action: "reopen" })).line, 'Reopened "Review portal invoice".');
  const t4 = s.f.rows("project_tasks").find((t) => t.id === "t4")!;
  assertEquals([t4.status, t4.completed_at], ["todo", null]);

  // Reopened personal to-do, then cancelled: the personal list has no cancelled state, so it is removed.
  await tool("update_task").run(s.c, { task: "umbrella roofing proposal", action: "reopen" });
  assertEquals((await tool("update_task").run(s.c, { task: "umbrella roofing proposal", action: "cancel" })).line, 'Removed "Send Umbrella Roofing proposal" from your list.');
  assertEquals(s.f.rows("calendar_tasks").some((t) => t.id === "t1"), false);
});

Deno.test("update_task: several matches ask; none says so; update changes due, assignee, priority", async () => {
  const s = setup(TASKS);
  await tool("update_task").run(s.c, { task: "portal invoice", action: "reopen" });
  const amb = await tool("update_task").run(s.c, { task: "review portal", action: "complete" });
  // Two open "review portal" tasks, one of them his: his own wins.
  assertEquals(amb.line, 'Marked "Review portal invoice" done.');
  const both = await tool("update_task").run(setup({ ...TASKS, project_tasks: TASKS.project_tasks.map((t) => ({ ...t, status: "todo", assigned_user_id: "maria" })) }).c, { task: "review portal", action: "complete" });
  assertEquals([both.clarify, both.line.startsWith("Which task:")], [true, true]);
  assertEquals((await tool("update_task").run(s.c, { task: "nonexistent thing", action: "complete" })).clarify, true);

  const up = await tool("update_task").run(s.c, { task: "QA report", action: "update", due: "2026-11-20", assignee: "me", priority: "urgent" });
  assertEquals(up.line, 'Updated "Review portal QA report": due 2026-11-20, assigned to you, priority urgent.');
  const t3 = s.f.rows("project_tasks").find((t) => t.id === "t3")!;
  assertEquals([t3.due_date, t3.assigned_user_id, t3.priority], ["2026-11-20", "owner", "urgent"]);

  // A personal to-do handed to a teammate moves to their list; urgent isn't a personal priority.
  const mv = await tool("update_task").run(s.c, { task: "umbrella roofing proposal", action: "update", assignee: "Maria", priority: "urgent" });
  assertEquals(mv.line, 'Updated "Send Umbrella Roofing proposal": assigned to Maria Diaz, priority high.');
  const t1 = s.f.rows("calendar_tasks").find((t) => t.id === "t1")!;
  assertEquals([t1.user_id, t1.calendar_id, t1.priority], ["maria", "cal2", "high"]);
  assertEquals((await tool("update_task").run(s.c, { task: "umbrella roofing proposal", action: "update", assignee: "Bob" })).line.startsWith('Nobody on the team matches "Bob"'), true);
  assertEquals((await tool("update_task").run(s.c, { task: "umbrella roofing proposal", action: "update" })).line, 'What should I change on "Send Umbrella Roofing proposal"?');
});

Deno.test("create_task: assignee puts it on a teammate's list; FRIDAY is never given a silent task", async () => {
  const s = setup();
  const r = await tool("create_task").run(s.c, { title: "Send onboarding pack", assignee: "maria", due: "2026-11-14" });
  assertEquals(r.line.startsWith('Task created for Maria Diaz: "Send onboarding pack"'), true);
  assertEquals(s.f.rows("calendar_tasks").map((t) => [t.user_id, t.calendar_id]), [["maria", "cal2"]]);
  const fr = await tool("create_task").run(s.c, { title: "Fix the login bug", assignee: "friday" });
  assertEquals([fr.ok, fr.line.startsWith("FRIDAY doesn't work from the task list"), s.f.rows("calendar_tasks").length], [false, true, 1]);
  const mine = await tool("create_task").run(s.c, { title: "Review contract", assignee: "me" });
  assertEquals([mine.ok, s.f.rows("calendar_tasks")[1].user_id], [true, "owner"]);
});

Deno.test("create_project: first stage of the pipeline, owner assigned; only claims a playbook that started", async () => {
  const s = setup();
  const r = await tool("create_project").run(s.c, { name: "Umbrella Roofing Dispatch App", client: "Casey", target_date: "2027-01-15", priority: "high" });
  assertEquals(r.line, 'Opened the project "Umbrella Roofing Dispatch App" for Casey Lee in Engineering (Planning).');
  const p = s.f.rows("projects").find((x) => x.name === "Umbrella Roofing Dispatch App")!;
  assertEquals([p.org_id, p.pipeline_id, p.stage_id, p.contact_id, p.status, p.priority, p.target_end_date, p.assigned_user_id, p.created_by], ["o", "pl1", "st1", "c1", "active", "high", "2027-01-15", "owner", "owner"]);
  assertEquals((await tool("create_project").run(s.c, { name: "initech box portal" })).clarify, true);
  assertEquals((await tool("create_project").run(s.c, { name: "New thing", pipeline: "Marketing" })).line, "Which pipeline: Engineering, CAIO Engagements?");
  assertEquals((await tool("create_project").run(s.c, { name: "CAIO thing", pipeline: "caio" })).line, "The CAIO Engagements pipeline has no stages. Nothing was created.");
  assertEquals(s.f.rows("projects").length, 2);
});

Deno.test("update_project: changes only what was asked", async () => {
  const s = setup();
  const r = await tool("update_project").run(s.c, { project: "initech", status: "on_hold", risk: "high", progress: 40 });
  assertEquals(r.line, "Updated Initech Box Portal: status on hold, risk high, progress 40%.");
  const p = s.f.rows("projects").find((x) => x.id === "p1")!;
  assertEquals([p.status, p.risk_level, p.progress_percent, p.priority], ["on_hold", "high", 40, "medium"]);
  assertEquals((await tool("update_project").run(s.c, { project: "initech" })).line, "What should I change on Initech Box Portal?");
  assertEquals((await tool("update_project").run(s.c, { project: "nope", status: "active" })).clarify, true);
});

const BOOKINGS: Seed = {
  appointment_types: [{ id: "ty1", name: "Capability Briefing" }, { id: "ty2", name: "Discovery w/Jordan Example" }],
  appointments: [
    { id: "a1", org_id: "o", status: "scheduled", start_at_utc: "2026-11-13T15:00:00Z", end_at_utc: "2026-11-13T15:30:00Z", contact_id: "c1", appointment_type_id: "ty1", cancel_token: "ct1", reschedule_token: "rt1" },
    { id: "a2", org_id: "o", status: "scheduled", start_at_utc: "2026-11-14T18:00:00Z", end_at_utc: "2026-11-14T19:00:00Z", contact_id: "c3", appointment_type_id: "ty2", cancel_token: "ct2", reschedule_token: "rt2" },
    { id: "a3", org_id: "o", status: "scheduled", start_at_utc: "2026-11-01T18:00:00Z", end_at_utc: "2026-11-01T19:00:00Z", contact_id: "c1", appointment_type_id: "ty2", cancel_token: "ct3", reschedule_token: "rt3" },
  ],
};

Deno.test("change_booking: cancels or moves one booking through the booking API; asks when unclear", async () => {
  const s = setup(BOOKINGS);
  const amb = await tool("change_booking").run(s.c, { action: "cancel" });
  assertEquals([amb.clarify, amb.line.startsWith("Which one:"), s.log.length], [true, true, 0]);
  const r = await tool("change_booking").run(s.c, { action: "cancel", meeting: "my call with Casey", reason: "Travelling" });
  assertEquals(r.line, "Cancelled Fri, Nov 13, 10:00 AM Capability Briefing with Casey Lee. The guest gets the cancellation email.");
  assertEquals(s.log, ['{"action":"cancel","token":"ct1","reason":"Travelling"}']);
  const mv = await tool("change_booking").run(s.c, { action: "reschedule", on: "2026-11-14", new_start: "2026-11-17T14:00:00-05:00" });
  assertEquals(mv.line, "Moved Sat, Nov 14, 1:00 PM Discovery w/Jordan Example with Sam Park to Tue, Nov 17, 2:00 PM. The guest gets the new time by email.");
  assertEquals(s.log[1], '{"action":"reschedule","token":"rt2","startISO":"2026-11-17T19:00:00.000Z","endISO":"2026-11-17T20:00:00.000Z"}');
  assertEquals((await tool("change_booking").run(s.c, { action: "reschedule", meeting: "Sam", new_start: "2026-11-01T10:00:00Z" })).line, "That time is in the past. When did you mean?");
});

Deno.test("change_booking: a refusal from the booking API is reported, not papered over", async () => {
  const s = setup(BOOKINGS, { changeBooking: () => Promise.resolve({ ok: false, error: "That new time is no longer available." }) });
  const r = await tool("change_booking").run(s.c, { action: "reschedule", meeting: "Casey", new_start: "2026-11-18T15:00:00Z" });
  assertEquals([r.ok, r.line.includes("That new time is no longer available"), r.line.endsWith("Nothing was changed.")], [false, true, true]);
  const none = setup(BOOKINGS, { changeBooking: undefined });
  assertEquals((await tool("change_booking").run(none.c, { action: "cancel", meeting: "Casey" })).ok, false);
});

Deno.test("harvey_status and harvey_command", async () => {
  const snap = { paused: false, running: true, email: { sent_today: 12, daily_cap: 40 }, pending_review: 3, open_conversations: 1, linkedin: { mode: "assist", queue: [{}, {}], sent_today: 0 }, prospects: { new: 5 } };
  const s = setup({ harvey_status: [{ org_id: "o", snapshot: snap, updated_at: "2026-11-12T14:59:00Z" }] });
  const r = await tool("harvey_status").run(s.c, {});
  assertEquals(r.line, "Harvey is running: 12/40 emails today, 3 drafts waiting for your review, 1 open conversation.");
  assertEquals(JSON.parse(r.detail!).linkedin, { mode: "assist", sent_today: 0, waiting_for_owner: 2 });
  const old = setup({ harvey_status: [{ org_id: "o", snapshot: { ...snap, paused: true, paused_reason: "owner" }, updated_at: "2026-11-11T09:00:00Z" }] });
  const st = (await tool("harvey_status").run(old.c, {})).line;
  assertEquals([st.startsWith("Harvey is paused (owner), but he last reported"), st.includes("may be out of date")], [true, true]);
  assertEquals((await tool("harvey_status").run(setup().c, {})).line.startsWith("Harvey has never reported"), true);

  const cmd = await tool("harvey_command").run(s.c, { command: "pause" });
  assertEquals(cmd.line, "Told Harvey to pause. He picks it up within about a minute; it isn't done until he does.");
  assertEquals(s.f.rows("harvey_commands").map((x) => [x.org_id, x.requested_by, x.command]), [["o", "owner", "pause"]]);
  assertEquals((await tool("harvey_command").run(s.c, { command: "linkedin_sent" })).clarify, true);
  assertEquals(s.f.rows("harvey_commands").length, 1);
});

Deno.test("manage tools refuse anyone who isn't the verified owner", async () => {
  const { runTool, NOT_OWNER_LINE } = await import("./owner-tools.ts");
  const s = setup({}, { ownerVerified: false });
  for (const t of MANAGE_TOOLS) assertEquals((await runTool(t, s.c, { name: "X Y", command: "pause", action: "cancel" })).line, NOT_OWNER_LINE);
  assertEquals([s.f.rows("contacts").length, s.f.rows("harvey_commands").length], [4, 0]);
});

Deno.test("the prompt routes uncovered OS work to FRIDAY and keeps money out of it", () => {
  const p = ownerSystemPrompt({ get: () => undefined }, NOW, "chat");
  assertEquals([p.includes("delegate_to_friday (kind task)"), p.includes("never hand that to FRIDAY"), p.includes("say plainly you can't do that yet")], [true, true, false]);
  assertEquals(tool("delegate_to_friday").description.includes("Never use it to pay, charge, refund or spend"), true);
});

Deno.test("save_contact: alternate_email adds a further address to an existing contact, keeps the main one, and is honest when it can't", async () => {
  const s = setup();
  const r = await tool("save_contact").run(s.c, { contact: "Casey", alternate_email: "CaseySample@Gmail.com" });
  assertEquals([r.ok, r.line.startsWith("Added caseysample@gmail.com as another address for Casey Lee.")], [true, true]);
  assertEquals(s.f.rows("contact_emails").map((x) => [x.organization_id, x.contact_id, x.email, x.source, x.created_by]), [["o", "c1", "caseysample@gmail.com", "clara", "clara"]]);
  assertEquals(s.f.rows("contacts").find((x) => x.id === "c1")!.email, "casey@acme.com");

  // together with another change: both are reported
  const both = await tool("save_contact").run(s.c, { contact: "Sam Park", job_title: "CTO", alternate_email: "sam.p@proton.me" });
  assertEquals(both.line.startsWith("Updated Sam Park: title CTO. Added sam.p@proton.me as another address for Sam Park."), true);

  assertEquals((await tool("save_contact").run(s.c, { contact: "Casey", alternate_email: "nope" })).clarify, true);
  assertEquals((await tool("save_contact").run(s.c, { name: "New Person", alternate_email: "x@y.co" })).line, "Whose other address is that? Give me the existing contact.");
  assertEquals(s.f.rows("contact_emails").length, 2);
});

Deno.test("save_contact: an address that is already someone's is refused, and a change made alongside is still reported", async () => {
  const s = setup();
  s.f.opts.unique = { ...(s.f.opts.unique ?? {}), contact_emails: [["organization_id", "email"]] };
  s.f.rows("contact_emails").push({ organization_id: "o", contact_id: "c3", email: "shared@gmail.com" });
  const r = await tool("save_contact").run(s.c, { contact: "Casey", alternate_email: "shared@gmail.com" });
  assertEquals([r.ok, r.line], [false, "I couldn't add shared@gmail.com to Casey Lee: shared@gmail.com already belongs to a contact in the CRM. Nothing was changed."]);
  const mixed = await tool("save_contact").run(s.c, { contact: "Casey", company: "Acme Co", alternate_email: "shared@gmail.com" });
  assertEquals([mixed.ok, mixed.line], [false, "Updated Casey Lee: company Acme Co. But I couldn't add shared@gmail.com to Casey Lee: shared@gmail.com already belongs to a contact in the CRM."]);
});
