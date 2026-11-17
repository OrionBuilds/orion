import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase } from "./testing/fake-supabase.ts";
import { enrichEvent, loadRecipient } from "./notification-enrich.ts";

const seed = () => new FakeSupabase({
  users: [
    { id: "u-sarah", name: "Sarah Lee", email: "sarah@x.com", role: { name: "Admin" } },
    { id: "u-jordan", name: "Jordan Example", email: "jordan@x.com", role: { name: "SuperAdmin" } },
    { id: "u-clara", name: "Clara", email: "clara@x.com", role: { name: "ClaraAgent" } },
  ],
  contacts: [{ id: "c1", first_name: "Pat", last_name: "Jones", email: "pat@x.com", phone: "555", company: "Acme" }],
  projects: [{ id: "p1", name: "Website rebuild", status: "active" }],
  contact_tasks: [{ id: "t1", title: "Send proposal", description: "Q4 template", due_date: "2026-11-06T00:00:00Z", priority: "high", assigned_to_user_id: "u-jordan", created_by_user_id: "u-sarah", contact_id: "c1" }],
  project_tasks: [{ id: "t2", title: "Wire the CMS", description: null, due_date: "2026-11-10", priority: "urgent", assigned_user_id: "u-jordan", created_by: "u-sarah", project_id: "p1" }],
  calendar_tasks: [{ id: "t3", title: "Review notes", description: "", due_at_utc: "2026-11-02T15:00:00Z", priority: "low", user_id: "u-jordan", created_by: "u-jordan" }],
  appointments: [{ id: "a1", calendar_id: "cal1", appointment_type_id: "ty1", contact_id: "c1", assigned_user_id: "u-jordan", status: "scheduled", start_at_utc: "2026-11-03T19:00:00Z", end_at_utc: "2026-11-03T19:30:00Z", visitor_timezone: "America/Chicago", answers: { name: "Pat", email: "pat@x.com", company: "Acme" }, google_meet_link: "https://meet/x" }],
  appointment_types: [{ id: "ty1", name: "Discovery call" }],
  calendars: [{ id: "cal1", name: "Discovery w/Jordan", slug: "studio" }],
  forms: [{ id: "f1", name: "Get In Touch", public_slug: "get-in-touch", definition: { fields: [{ id: "first_name", label: "First" }, { id: "budget_range", label: "Budget" }, { id: "_honeypot" }] } }],
  form_submissions: [{ id: "s1", form_id: "f1", contact_id: "c1", payload: { first_name: "Pat", budget_range: "25_75k", _honeypot: "" }, attribution: { landing_page: "https://example.com/get-in-touch" } }],
  opportunities: [
    { id: "o-old", contact_id: "c1", status: "won", created_at: "2026-01-01", stage_id: "st1", assigned_user_id: "u-jordan" },
    { id: "o-open", contact_id: "c1", status: "open", created_at: "2026-02-01", name: "Pat — Get In Touch", value_amount: 25000, currency: "USD", source: "web_form_get-in-touch", stage_id: "st1", assigned_user_id: "u-jordan" },
  ],
  pipeline_stages: [{ id: "st1", name: "New Lead" }],
  conversations: [{ id: "cv1", contact_id: "c1", assigned_user_id: "u-jordan", channel: "sms" }],
});

Deno.test("contact task: loads description, assigner and contact; legacy event type works too", async () => {
  const db = seed();
  const p = await enrichEvent(db, { event_type: "contact_task_added", entity_type: "contact_task", entity_id: "t1", contact_id: "c1",
    payload: { task_id: "t1", title: "Send proposal", due_date: "2026-11-06T00:00:00Z", priority: "high", assigned_to_user_id: "u-jordan", contact_id: "c1" } });
  assertEquals(p.task_kind, "contact");
  assertEquals(p.description, "Q4 template");
  assertEquals(p.assigner_name, "Sarah Lee");
  assertEquals(p.contact_name, "Pat Jones");
  assertEquals(p.contact_company, "Acme");
  assertEquals(p.assigned_to_user_id, "u-jordan");
});

Deno.test("project and personal tasks load from their own tables", async () => {
  const db = seed();
  const proj = await enrichEvent(db, { event_type: "task_assigned", entity_type: "task", entity_id: "t2", contact_id: null,
    payload: { task_kind: "project", task_id: "t2", assigned_to_user_id: "u-jordan", assigner_user_id: "u-sarah", project_id: "p1", via: "reassign" } });
  assertEquals(proj.project_name, "Website rebuild");
  assertEquals(proj.title, "Wire the CMS");
  assertEquals(proj.due, "2026-11-10");
  assertEquals(proj.assigner_name, "Sarah Lee");
  const personal = await enrichEvent(db, { event_type: "task_assigned", entity_type: "task", entity_id: "t3", contact_id: null,
    payload: { task_kind: "personal", task_id: "t3", assigned_to_user_id: "u-jordan" } });
  assertEquals(personal.title, "Review notes");
  assertEquals(personal.due, "2026-11-02T15:00:00Z");
});

Deno.test("appointment: thin trigger payload becomes type, contact, time zone, meet link and assignee", async () => {
  const db = seed();
  const p = await enrichEvent(db, { event_type: "appointment_booked", entity_type: "appointment", entity_id: "a1", contact_id: "c1",
    payload: { appointment_id: "a1", status: "scheduled", contact_id: "c1" } });
  assertEquals(p.appointment_type, "Discovery call");
  assertEquals(p.calendar_name, "Discovery w/Jordan");
  assertEquals(p.contact_name, "Pat Jones");
  assertEquals(p.contact_email, "pat@x.com");
  assertEquals(p.visitor_timezone, "America/Chicago");
  assertEquals(p.google_meet_link, "https://meet/x");
  assertEquals(p.assigned_user_id, "u-jordan");
});

Deno.test("form submission: legacy thin payload is rebuilt from the stored submission and finds the open opportunity", async () => {
  const db = seed();
  const p = await enrichEvent(db, { event_type: "form_submitted", entity_type: "form_submission", entity_id: "s1", contact_id: "c1",
    payload: { form_id: "f1", submission_id: "s1", contact_id: "c1" } });
  assertEquals(p.form_name, "Get In Touch");
  assertEquals(p.first_name, "Pat");
  assertEquals(p.email, "pat@x.com");
  assertEquals(p.fields, [["First", "Pat"], ["Budget", "25_75k"]]);
  assertEquals(p.landing_page, "https://example.com/get-in-touch");
  assertEquals(p.opportunity_id, "o-open");
  assertEquals(p.assigned_user_id, "u-jordan");
});

Deno.test("form submission: a rich payload keeps its own fields and opportunity", async () => {
  const db = seed();
  const p = await enrichEvent(db, { event_type: "form_submitted", entity_type: "form_submission", entity_id: "s1", contact_id: "c1",
    payload: { form_id: "f1", submission_id: "s1", contact_id: "c1", opportunity_id: "o-old", form_name: "Scorecard 71/100", first_name: "Patricia", fields: [["Score", "71"]] } });
  assertEquals(p.form_name, "Scorecard 71/100");
  assertEquals(p.first_name, "Patricia");
  assertEquals(p.fields, [["Score", "71"]]);
  assertEquals(p.opportunity_id, "o-old");
});

Deno.test("opportunity and conversation load contact, stage and assignee names", async () => {
  const db = seed();
  const o = await enrichEvent(db, { event_type: "opportunity_created", entity_type: "opportunity", entity_id: "o-open", contact_id: "c1", payload: { opportunity_id: "o-open", source: "manual" } });
  assertEquals(o.name, "Pat — Get In Touch");
  assertEquals(o.stage_name, "New Lead");
  assertEquals(o.contact_name, "Pat Jones");
  assertEquals(o.assigned_name, "Jordan Example");
  assertEquals(o.value_amount, 25000);
  const c = await enrichEvent(db, { event_type: "conversation_assigned", entity_type: "conversation", entity_id: "cv1", contact_id: "c1", payload: { conversation_id: "cv1", channel: "sms", assigned_user_id: "u-jordan" } });
  assertEquals(c.contact_name, "Pat Jones");
  assertEquals(c.contact_phone, "555");
});

Deno.test("a missing entity leaves the payload untouched; agent recipients are flagged", async () => {
  const db = seed();
  const p = await enrichEvent(db, { event_type: "appointment_booked", entity_type: "appointment", entity_id: "nope", contact_id: null, payload: { appointment_id: "nope", start_at_utc: "2026-01-01T00:00:00Z" } });
  assertEquals(p.start_at_utc, "2026-01-01T00:00:00Z");
  assertEquals(p.appointment_type, undefined);
  assertEquals((await loadRecipient(db, "u-clara"))?.isAgent, true);
  assertEquals((await loadRecipient(db, "u-jordan"))?.isAgent, false);
  assertEquals(await loadRecipient(db, "ghost"), null);
});
