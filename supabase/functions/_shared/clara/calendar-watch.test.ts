import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { overlaps, prepMeetings, scanConflicts } from "./calendar-watch.ts";
import type { NotifyRequest } from "./notify.ts";

const NOW = new Date("2026-10-23T13:00:00Z");
const ENV = { get: (k: string) => ({ CLARA_TZ: "America/New_York" })[k] };
const ev = (id: string, startH: number, endH: number, extra: Record<string, unknown> = {}) => ({
  id, graph_event_id: `g-${id}`, user_id: "u", title: id, status: "confirmed", transparency: "opaque", attendees: [], organizer_email: null,
  start_time: new Date(NOW.getTime() + startH * 3_600_000).toISOString(), end_time: new Date(NOW.getTime() + endH * 3_600_000).toISOString(), ...extra,
});

Deno.test("overlap: touching is fine, intersecting is a conflict", () => {
  assertEquals(overlaps(ev("a", 1, 2), ev("b", 2, 3)), false);
  assertEquals(overlaps(ev("a", 1, 3), ev("b", 2, 4)), true);
});

Deno.test("conflicts are flagged once per pair; cancelled and 'free' events never conflict", async () => {
  const notes: NotifyRequest[] = [];
  const f = new FakeSupabase({ microsoft_calendar_events: [ev("A", 1, 3), ev("B", 2, 4), ev("C", 5, 6), ev("D", 2.5, 3.5, { status: "cancelled" }), ev("E", 1.5, 2.5, { transparency: "transparent" })] });
  const n = await scanConflicts(asClient(f), ENV, { userId: "u", now: NOW, notify: (r) => { notes.push(r); return Promise.resolve(); } });
  assertEquals(n, 1);
  assertEquals(notes[0].dedupeKey, "conflict:g-A:g-B");
  assertStringIncludes(notes[0].text, '"A"');
});

Deno.test("a meeting with a known client gets one briefing with projects, recent mail and feedback; strangers and internal-only meetings get none", async () => {
  const notes: NotifyRequest[] = [];
  const f = new FakeSupabase({
    microsoft_calendar_events: [
      ev("kickoff", 1, 1.5, { attendees: [{ email: "pat@acme.com" }, { email: "jordan@example.org" }] }),
      ev("stranger", 0.5, 1, { attendees: [{ email: "who@nowhere.com" }] }),
      ev("internal", 0.6, 1, { attendees: [{ email: "jordan@example.org" }] }),
      ev("later", 5, 6, { attendees: [{ email: "pat@acme.com" }] }),
    ],
    contacts: [{ id: "c1", organization_id: "o", status: "active", email: "pat@acme.com", first_name: "Pat", last_name: "Lee", company: "Acme" }],
    projects: [{ id: "p1", contact_id: "c1", name: "Acme Site", status: "active" }],
    project_tasks: [{ project_id: "p1", title: "Migrate checkout", status: "in_progress", updated_at: "2026-10-22" }, { project_id: "p1", title: "Footer links", status: "completed", updated_at: "2026-10-21" }],
    messages: [{ contact_id: "c1", channel: "email", direction: "inbound", subject: "Checkout", body: "It errors since yesterday", sent_at: "2026-10-22T12:00:00Z" }],
    contact_timeline: [{ contact_id: "c1", event_type: "feedback", event_data: { score: 4 }, created_at: "2026-10-10" }],
  });
  const res = await prepMeetings(asClient(f), ENV, { orgId: "o", userId: "u", now: NOW, ownerEmails: ["jordan@example.org"], notify: (r) => { notes.push(r); return Promise.resolve(); } });
  assertEquals(res.prepared, 1);
  assertEquals(notes[0].dedupeKey, "prep:g-kickoff");
  for (const s of ["Pat Lee (Acme)", "Acme Site (active)", "open: Migrate checkout", "recently done: Footer links", "they wrote (email", "last feedback: 4/5"]) assertStringIncludes(notes[0].text, s);
});
