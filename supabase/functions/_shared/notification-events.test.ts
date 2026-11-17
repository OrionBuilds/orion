import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { EVENTS, fmtDue, fmtWhen, renderEvent } from "./notification-events.ts";

const BASE = "https://os.example.com";

Deno.test("every event links to an existing app route (relative) and renders without a payload", () => {
  const routes = [
    /^\/calendars\?tab=tasks&taskId=.+/, /^\/calendars\?tab=list&appointmentId=.+/, /^\/opportunities\/.+/, /^\/contacts\/.+/,
    /^\/marketing\/forms\/.+\/submissions$/, /^\/marketing(\/forms|\/surveys\/.+\/submissions)?$/, /^\/proposals\/.+/, /^\/contracts\/.+/,
    /^\/payments(\/invoices\/.+)?$/, /^\/projects\/.+/, /^\/conversations\/.+/, /^\/settings\/ai-agents$/,
  ];
  for (const [type, cfg] of Object.entries(EVENTS)) {
    const r = renderEvent(cfg, { project_id: "p1", form_id: "f1", contact_id: "c1" }, "e1", BASE);
    assert(r.link, `${type} has a link`);
    assert(routes.some((re) => re.test(r.link!)), `${type} link ${r.link} is a known route`);
    assert(r.cta?.url.startsWith(`${BASE}/`), `${type} cta is absolute`);
    assert(r.title.length > 0 && r.subject.length > 0, `${type} renders a title and subject`);
  }
  assert(!("workflow_run_failed" in EVENTS));
  assert(!("review_received" in EVENTS));
});

Deno.test("task email says who assigned what, for whom, when, and deep-links the task", () => {
  const r = renderEvent(EVENTS.task_assigned, {
    task_kind: "contact", task_id: "t1", title: "Send proposal", description: "Use the Q4 template", due: "2026-11-06",
    priority: "high", assigner_name: "Sarah Lee", contact_name: "Pat Jones", contact_company: "Acme", via: "insert",
  }, "t1", BASE);
  assertEquals(r.subject, "Task assigned: Send proposal (due Fri, Nov 6)");
  assertEquals(r.intro, "Sarah Lee assigned you a contact task.");
  assertEquals(r.link, "/calendars?tab=tasks&taskId=t1");
  assertEquals(r.cta, { label: "Open task", url: `${BASE}/calendars?tab=tasks&taskId=t1` });
  const rows = Object.fromEntries(r.rows);
  assertEquals(rows.For, "Pat Jones · Acme");
  assertEquals(rows.Due, "Fri, Nov 6");
  assertEquals(rows.Priority, "High");
  assertEquals(rows["Assigned by"], "Sarah Lee");
  assertEquals(rows.Description, "Use the Q4 template");
  assertStringIncludes(r.body, 'Sarah Lee assigned you "Send proposal" for Pat Jones · due Fri, Nov 6');
});

Deno.test("legacy contact_task_added renders identically to task_assigned", () => {
  assertEquals(EVENTS.contact_task_added, EVENTS.task_assigned);
});

Deno.test("appointment email formats the start in the visitor's zone and links the appointment", () => {
  const r = renderEvent(EVENTS.appointment_booked, {
    appointment_id: "a1", start_at_utc: "2026-11-03T19:00:00Z", visitor_timezone: "America/New_York",
    appointment_type: "Discovery call", contact_name: "Pat Jones", contact_email: "pat@x.com", calendar_name: "Discovery w/Jordan Example",
    google_meet_link: "https://meet.google.com/abc", answers: { name: "Pat", email: "pat@x.com", company: "Acme" },
  }, "a1", BASE);
  assertEquals(r.subject, "Booked: Discovery call with Pat Jones — Tue, Nov 3, 2:00 PM EST");
  assertEquals(r.link, "/calendars?tab=list&appointmentId=a1");
  const rows = Object.fromEntries(r.rows);
  assertEquals(rows.When, "Tue, Nov 3, 2:00 PM EST");
  assertEquals(rows["Meet link"], "https://meet.google.com/abc");
  assertEquals(rows.Answers, "company: Acme");
  assertEquals(fmtWhen("2026-07-01T16:30:00Z", "Not/AZone"), "Wed, Jul 1, 12:30 PM EDT");
  assertEquals(fmtWhen("garbage"), "");
  assertEquals(fmtDue("2026-11-06T04:00:00Z", "America/New_York"), "Thu, Nov 5, 11:00 PM"); // EST is UTC-5
  assertEquals(fmtDue("2026-11-06"), "Fri, Nov 6"); // a bare date stays calendar-exact
});

Deno.test("form_submitted prefers the opportunity link, then contact, then the form, and lists every field", () => {
  const p = { form_name: "Contact (example.org)", first_name: "Jane", last_name: "Doe", email: "jane@x.com", company: "Acme",
    fields: [["Help type", "Fractional CMO"], ["Problem", "Leads dry up"]] };
  const withOpp = renderEvent(EVENTS.form_submitted, { ...p, opportunity_id: "o1", contact_id: "c1" }, "s1", BASE);
  assertEquals(withOpp.subject, "New lead: Jane Doe (Acme) — Contact (example.org)");
  assertEquals(withOpp.link, "/opportunities/o1");
  assertEquals(withOpp.rows.slice(-2), [["Help type", "Fractional CMO"], ["Problem", "Leads dry up"]]);
  assertStringIncludes(withOpp.intro!, "an Inbound / New Lead opportunity was created");
  assertEquals(renderEvent(EVENTS.form_submitted, { ...p, contact_id: "c1" }, "s1", BASE).link, "/contacts/c1");
  assertEquals(renderEvent(EVENTS.form_submitted, { ...p, form_id: "f1" }, "s1", BASE).link, "/marketing/forms/f1/submissions");
});

Deno.test("opportunity_created is gated for sources that notify through their own event", () => {
  const g = EVENTS.opportunity_created.gate!;
  assert(g({ source: "web_form_get-in-touch" }));
  assert(g({ source: "booking" }));
  assert(g({ source: "readiness-scorecard" }));
  assert(g({ source: "clara_web" }));
  assertEquals(g({ source: "manual" }), null);
  assertEquals(g({}), null);
  assertEquals(EVENTS.opportunity_status_changed.gate!({ new_status: "qualified" }), "status not won/lost");
  assertEquals(EVENTS.opportunity_status_changed.gate!({ new_status: "Won" }), null);
});

Deno.test("project links carry the real tab ids and the AI agents page is under settings", () => {
  assertEquals(renderEvent(EVENTS.change_request_created, { project_id: "p1" }, "cr1", BASE).link, "/projects/p1?tab=change_requests");
  assertEquals(renderEvent(EVENTS.support_ticket_created, { project_id: "p1" }, "t1", BASE).link, "/projects/p1?tab=support_tickets");
  assertEquals(renderEvent(EVENTS.invoice_paid, { doc_number: "INV-7", total: 1200 }, "i1", BASE).link, "/payments/invoices/i1");
  assertEquals(renderEvent(EVENTS.ai_agent_failed, {}, "x", BASE).link, "/settings/ai-agents");
});
